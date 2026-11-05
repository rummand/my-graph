/**
 * The running side of observability (server-only, Node): one collector and one error buffer per process, flushed to
 * the database every minute (errors within a few seconds). Started from src/instrumentation.ts.
 *
 * - Timings: every request Next.js traces (see otel.ts) adds a sample: route pattern, method, status, duration.
 * - Slow requests (over OBS_SLOW_MS, default 2000 ms) and 5xx answers without an exception become error groups.
 * - Thrown errors arrive through instrumentation's onRequestError and captureError().
 *
 * Turn it all off with OBS_DISABLED=1. Failures here are logged once per kind and never reach a request.
 */
import { TimingCollector } from "./collector";
import { foldEvent, isExpected, toErrorEvent, type ErrorAgg, type ErrorInput, type ErrorSource } from "./errors";
import { markRequestErrored, registerRequestTimer, type RequestEnd } from "./otel";

const FLUSH_MS = 60_000;
const ERROR_FLUSH_MS = 5_000;
const PRUNE_EVERY_MS = 6 * 3600_000;

type State = {
  started: boolean;
  timing: boolean;
  collector: TimingCollector;
  errors: Map<string, ErrorAgg>;
  timer?: ReturnType<typeof setInterval>;
  errorTimer?: ReturnType<typeof setTimeout>;
  flushing: boolean;
  lastPrune: number;
  seenRoutes: Set<string>;
  warned: Set<string>;
};

const G = globalThis as unknown as { __mgObs?: State };

export function slowThresholdMs(): number {
  const n = Number(process.env.OBS_SLOW_MS);
  return Number.isFinite(n) && n >= 100 ? n : 2000;
}

function state(): State {
  if (!G.__mgObs) {
    G.__mgObs = {
      started: false, timing: false, collector: new TimingCollector({ slowMs: slowThresholdMs() }), errors: new Map(), flushing: false,
      lastPrune: 0, seenRoutes: new Set(), warned: new Set(),
    };
  }
  return G.__mgObs;
}

export const observabilityDisabled = () => process.env.OBS_DISABLED === "1";

/** Salt for hashing account ids. Read from the environment, never logged or stored. */
function salt(): string {
  return process.env.OBS_HASH_SALT || process.env.SESSION_SECRET || "my-graph-obs";
}

function warnOnce(key: string, err: unknown) {
  const s = state();
  if (s.warned.has(key)) return;
  s.warned.add(key);
  console.error(`[observability] ${key}:`, err instanceof Error ? err.message : String(err));
}

/** Start collecting (idempotent). Returns whether request timings are wired (another OpenTelemetry setup disables them). */
export function startObservability(): boolean {
  const s = state();
  if (s.started || observabilityDisabled()) return s.timing;
  s.started = true;
  s.timing = registerRequestTimer(onRequestEnd);
  if (!s.timing) console.warn("[observability] another OpenTelemetry setup is active; route timings are off, errors are still captured");
  s.timer = setInterval(() => { void flushObservability(); }, FLUSH_MS);
  s.timer.unref?.();
  return s.timing;
}

const SKIP = /^\/(_next|__nextjs|favicon\.ico|icons\/|manifest\.webmanifest|robots\.txt)/;

/** A finished request (from otel.ts). Exported for tests. */
export function onRequestEnd(r: RequestEnd): void {
  if (!r.route || SKIP.test(r.route)) return;
  const s = state();
  const method = r.rsc ? "RSC" : r.method;
  s.collector.record({ route: r.route, method, ms: r.ms, status: r.status });
  const key = `${method} ${r.route}`;
  // In development the first hit of a route includes compiling it: not a slow request worth reporting.
  const firstDevHit = process.env.NODE_ENV === "development" && !s.seenRoutes.has(key);
  if (s.seenRoutes.size < 2000) s.seenRoutes.add(key);
  if (r.ms >= slowThresholdMs() && !firstDevHit) queueError({ kind: "slow", route: r.route, method, status: r.status, durationMs: r.ms });
  if (r.status >= 500 && !r.errored) queueError({ kind: "status", route: r.route, method, status: r.status, durationMs: r.ms });
}

function queueError(input: ErrorInput): void {
  if (observabilityDisabled()) return;
  const s = state();
  try {
    foldEvent(s.errors, toErrorEvent(input, salt()));
  } catch (err) {
    warnOnce("grouping failed", err);
    return;
  }
  if (!s.errorTimer) {
    s.errorTimer = setTimeout(() => { s.errorTimer = undefined; void flushErrors(); }, ERROR_FLUSH_MS);
    s.errorTimer.unref?.();
  }
}

export type CaptureContext = { route?: string | null; method?: string | null; source?: ErrorSource; status?: number | null; userId?: string | null };

/**
 * Report a server error. Control flow (redirect, notFound) and deliberate 4xx Responses are ignored. Only the error's
 * name, a redacted message and its stack frames are kept, with the route pattern and a hash of the account.
 */
export function captureError(err: unknown, ctx: CaptureContext = {}): void {
  if (observabilityDisabled() || isExpected(err)) return;
  markRequestErrored();
  const e = err instanceof Error ? err : null;
  const status = typeof Response !== "undefined" && err instanceof Response ? err.status : ctx.status ?? null;
  queueError({
    kind: "error",
    name: e?.name ?? (status ? "ErrorResponse" : typeof err),
    message: e?.message ?? (status ? `Thrown response with status ${status}` : "Non-error value thrown"),
    stack: e?.stack ?? null,
    digest: digestOf(err),
    route: ctx.route, method: ctx.method, source: ctx.source ?? "request", status, userId: ctx.userId ?? null,
  });
}

function digestOf(err: unknown): string | null {
  const d = err && typeof err === "object" ? (err as { digest?: unknown }).digest : undefined;
  return typeof d === "string" ? d : null;
}

async function flushErrors(): Promise<void> {
  const s = state();
  if (!s.errors.size) return;
  const groups = [...s.errors.values()];
  s.errors = new Map();
  try {
    const { writeErrors } = await import("./store");
    await writeErrors(groups);
  } catch (err) {
    warnOnce("could not write errors", err);
    // Put them back (bounded by foldEvent's group cap) for the next try.
    for (const g of groups) {
      const cur = s.errors.get(g.event.fingerprint);
      if (cur) { cur.count += g.count; for (const h of g.userHashes) if (cur.userHashes.size < 50) cur.userHashes.add(h); }
      else if (s.errors.size < 500) s.errors.set(g.event.fingerprint, g);
    }
  }
}

/** Write what's collected now (the minute timer calls this; tests and shutdown may too). */
export async function flushObservability(): Promise<void> {
  const s = state();
  if (s.flushing) return;
  s.flushing = true;
  try {
    await flushErrors();
    const rows = s.collector.drain();
    if (rows.length) {
      try {
        const { writeTimings } = await import("./store");
        await writeTimings(rows);
      } catch (err) {
        warnOnce("could not write timings", err);
        s.collector.restore(rows);
      }
    }
    if (Date.now() - s.lastPrune > PRUNE_EVERY_MS) {
      s.lastPrune = Date.now();
      try {
        const { pruneObservability } = await import("./store");
        await pruneObservability();
      } catch (err) {
        warnOnce("could not prune", err);
      }
    }
  } finally {
    s.flushing = false;
  }
}

/** What this process is holding right now (for the Performance page's "not yet written" note). */
export function pendingCounts(): { timings: number; errors: number; timing: boolean } {
  const s = state();
  return { timings: s.collector.size, errors: s.errors.size, timing: s.timing };
}
