/**
 * Running a connection (server-only). One run = claim (atomic lease) → run as the person in the connection's graph →
 * per-stream commits (cursor + data in one transaction) → status, back-off and next run → the run's log row.
 *
 * Claiming: `state.leaseUntil` is set with a single-row UPDATE … WHERE lease expired, so two ticks, two app instances
 * or a tick and "Run now" never run the same connection at once. A run that dies keeps its lease only until it ends.
 * Every run is bounded by RUN_TIMEOUT_MS (an AbortSignal the connector passes to its network calls).
 */
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { connectionRuns, connections } from "@/db/schema";
import { viewerFor } from "@/lib/auth/viewer-for";
import { scopeOf } from "@/lib/graphs/pure";
import { decryptSecrets, redact } from "./crypto";
import { classify, CursorExpired } from "./errors";
import { connectorById } from "./registry";
import { afterRun, readState, resetStream, withCursor, type ConnectionState } from "./state";
import type { ConnectionRow, CountKey, RunContext, StreamCounts } from "./types";

export const TICK_MS = 60_000;
export const LEASE_MS = 10 * 60_000;
export const RUN_TIMEOUT_MS = 5 * 60_000;
const CLAIM_BATCH = 5;

type LeasedState = ConnectionState & { leaseUntil?: string | null };

function rowFrom(r: Record<string, unknown>): ConnectionRow {
  const d = (x: unknown) => (x ? (x instanceof Date ? x : new Date(String(x))) : null);
  return {
    id: String(r.id), graphId: String(r.graph_id), userId: String(r.user_id), connector: String(r.connector), label: String(r.label),
    config: (r.config as Record<string, unknown>) ?? {}, secrets: (r.secrets as string | null) ?? null, state: (r.state as Record<string, unknown>) ?? {},
    status: String(r.status), statusDetail: (r.status_detail as string | null) ?? null, everyMinutes: Number(r.every_minutes) || 15,
    nextRunAt: d(r.next_run_at), lastRunAt: d(r.last_run_at), lastOkAt: d(r.last_ok_at), createdAt: d(r.created_at) ?? new Date(), updatedAt: d(r.updated_at) ?? new Date(),
  };
}

const leaseExpired = sql`coalesce((${connections.state}->>'leaseUntil')::timestamptz, 'epoch'::timestamptz) < now()`;
const leaseSet = sql`jsonb_set(coalesce(${connections.state}, '{}'::jsonb), '{leaseUntil}', to_jsonb(to_char((now() + make_interval(secs => ${LEASE_MS / 1000})) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')))`;

/** Claim due connections (scheduled ones: ok or will-retry, due, not leased). */
export async function claimDue(limit = CLAIM_BATCH): Promise<ConnectionRow[]> {
  const rows = await db.execute<Record<string, unknown>>(sql`
    update ${connections} set state = ${leaseSet}
    where id in (
      select id from ${connections}
      where status in ('ok', 'error') and next_run_at is not null and next_run_at <= now() and ${leaseExpired}
      order by next_run_at limit ${limit}
      for update skip locked
    ) and ${leaseExpired}
    returning *`);
  return (rows as unknown as Record<string, unknown>[]).map(rowFrom);
}

/** Claim one connection now ("Run now", or right after it is made). Null when it is paused or already running. */
export async function claimOne(id: string, graphId: string): Promise<ConnectionRow | null> {
  const rows = await db.execute<Record<string, unknown>>(sql`
    update ${connections} set state = ${leaseSet}
    where id = ${id} and graph_id = ${graphId} and status <> 'paused' and ${leaseExpired}
    returning *`);
  const list = rows as unknown as Record<string, unknown>[];
  return list.length ? rowFrom(list[0]) : null;
}

export type RunOutcome = { runId: string | null; outcome: "ok" | "needs_you" | "retry"; message?: string };

/** Run a claimed connection to the end. Never throws. */
export async function runClaimed(row: ConnectionRow, trigger: "schedule" | "person" = "schedule"): Promise<RunOutcome> {
  const now = new Date();
  let state: LeasedState = { ...readState(row.state), leaseUntil: (row.state as LeasedState).leaseUntil ?? null };
  const counts: Record<string, StreamCounts> = {};
  const log: string[] = [];
  const changeSets: string[] = [];
  let secrets: Record<string, string> = {};

  // Runs that died with the process (still "running" after the lease) are closed first.
  await db.update(connectionRuns).set({ status: "failed", finishedAt: now, error: "Stopped before it finished (the app restarted or it ran too long)." })
    .where(and(eq(connectionRuns.connectionId, row.id), eq(connectionRuns.status, "running"), sql`${connectionRuns.startedAt} < now() - make_interval(secs => ${LEASE_MS / 1000})`)).catch(() => {});

  const [run] = await db.insert(connectionRuns).values({ connectionId: row.id, graphId: row.graphId, status: "running", counts: { trigger } })
    .returning({ id: connectionRuns.id }).catch(() => [] as { id: string }[]);
  const runId = run?.id ?? null;

  let outcome: RunOutcome["outcome"] = "ok";
  let message: string | undefined;
  let code: string | undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RUN_TIMEOUT_MS);
  (timer as { unref?: () => void }).unref?.();

  try {
    const connector = connectorById(row.connector);
    if (!connector?.sync || connector.manifest.status === "coming_soon") throw Object.assign(new Error("This kind of connection can't run yet."), { kind: "needs_you" });
    const viewer = await viewerFor(row.userId, row.graphId);
    if (!viewer) throw needs("You're no longer a member of this graph, so this connection can't bring anything into it.", "notMember");
    if (!scopeOf(viewer).canWrite) throw needs("You can only look at this graph now, so this connection can't add to it.", "readOnly");
    try {
      secrets = decryptSecrets(row.secrets, row.id);
    } catch {
      throw needs("The saved password or link can't be read any more. Enter it again.", "secretsUnreadable");
    }
    const cfg = connector.manifest.config.safeParse(row.config);
    if (!cfg.success) throw needs(`A setting needs fixing: ${cfg.error.issues[0]?.message ?? "invalid"}.`, "badConfig");

    const perMinute = connector.manifest.rateLimit.perMinute;
    let lastCall = 0;
    const ctx: RunContext = {
      viewer, connection: row, runId: runId ?? "", config: cfg.data as Record<string, unknown>, secrets, now, signal: controller.signal,
      state: () => state,
      async commit(stream, cursor, write) {
        const next: LeasedState = withCursor(state, stream, cursor);
        await db.transaction(async (tx) => {
          // Lock the connection row: a disconnect that happened mid-run means nothing more is stored.
          const [still] = await tx.select({ id: connections.id }).from(connections).where(eq(connections.id, row.id)).for("update");
          if (!still) throw needs("This connection was disconnected while it was running.", "disconnected");
          await write(tx);
          await tx.update(connections).set({ state: next as Record<string, unknown>, updatedAt: new Date() }).where(eq(connections.id, row.id));
        });
        state = next;
      },
      count(stream, key: CountKey, n = 1) {
        const c = (counts[stream] ??= {});
        c[key] = (c[key] ?? 0) + n;
      },
      log(line) { if (log.length < 50) log.push(redact(line, secrets).slice(0, 300)); },
      proposed(id) { if (id && !changeSets.includes(id)) changeSets.push(id); },
      async throttle() {
        const gap = 60_000 / perMinute;
        const wait = lastCall + gap - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, Math.min(wait, 10_000)));
        lastCall = Date.now();
        if (controller.signal.aborted) throw Object.assign(new Error("The run took too long and was stopped."), { name: "AbortError" });
      },
    };

    try {
      await connector.sync(ctx);
    } catch (e) {
      if (!(e instanceof CursorExpired)) throw e;
      // The one reset path: forget the stream's cursor and read again; the import skips what it already has.
      ctx.log(`${e.message} Reading it again from the start.`);
      state = resetStream(state, e.stream);
      await db.update(connections).set({ state: state as Record<string, unknown> }).where(eq(connections.id, row.id));
      await connector.sync(ctx);
    }
  } catch (e) {
    const k = (e as { kind?: string }).kind === "needs_you" ? { kind: "needs_you" as const, message: (e as Error).message, code: (e as { code?: string }).code } : classify(e);
    outcome = k.kind === "needs_you" ? "needs_you" : "retry";
    message = redact(k.message, secrets);
    code = k.code;
    if (process.env.NODE_ENV !== "test") console.warn(`[connectors] ${row.connector} ${row.id}: ${outcome}: ${message}`);
  } finally {
    clearTimeout(timer);
  }

  const done = new Date();
  const next = afterRun({ now: done, everyMinutes: row.everyMinutes, failures: state.failures ?? 0, outcome });
  const finalState: LeasedState = { ...state, failures: next.failures, lastError: message ?? null, leaseUntil: null };
  // A pause or disconnect during the run wins: only write the status if it is still not paused.
  await db.update(connections).set({
    state: finalState as Record<string, unknown>,
    status: sql`case when ${connections.status} = 'paused' then 'paused' else ${next.status} end`,
    statusDetail: outcome === "ok" ? null : `${code ? `${code}|` : ""}${message ?? ""}`.slice(0, 500),
    nextRunAt: sql`case when ${connections.status} = 'paused' then null else ${next.nextRunAt?.toISOString() ?? null}::timestamptz end`,
    lastRunAt: done,
    ...(outcome === "ok" ? { lastOkAt: done } : {}),
    updatedAt: done,
  }).where(eq(connections.id, row.id)).catch((e) => console.error("[connectors] couldn't save the run's outcome", e));

  if (runId) {
    await db.update(connectionRuns).set({
      status: outcome === "ok" ? "done" : "failed", finishedAt: done,
      counts: { trigger, streams: counts, log, changeSets, ...(code ? { code } : {}), ...(outcome === "needs_you" ? { needsYou: true } : {}) },
      changeSetId: changeSets[0] ?? null, error: message ?? null,
    }).where(eq(connectionRuns.id, runId)).catch(() => {});
  }
  return { runId, outcome, message };
}

function needs(message: string, code: string) {
  return Object.assign(new Error(message), { kind: "needs_you", code });
}

/* ── The scheduler ─────────────────────────────────────────────────────────────────────────────────────── */

type SchedState = { timer?: ReturnType<typeof setInterval>; ticking: boolean; started: boolean };
const g = globalThis as unknown as { __mgConnectors?: SchedState };
const sched: SchedState = g.__mgConnectors ?? (g.__mgConnectors = { ticking: false, started: false });

export async function tick(): Promise<number> {
  if (sched.ticking) return 0;
  sched.ticking = true;
  let n = 0;
  try {
    const due = await claimDue();
    for (const row of due) {
      await runClaimed(row, "schedule");
      n++;
    }
  } catch (e) {
    console.error("[connectors] tick failed:", e instanceof Error ? e.message : e);
  } finally {
    sched.ticking = false;
  }
  return n;
}

export function startConnectorScheduler(): void {
  if (sched.started || process.env.DISABLE_SCHEDULER === "1" || process.env.DISABLE_CONNECTORS === "1") return;
  sched.started = true;
  sched.timer = setInterval(() => { void tick(); }, TICK_MS);
  (sched.timer as { unref?: () => void }).unref?.();
  setTimeout(() => { void tick(); }, 20_000).unref?.();
  console.log("[connectors] scheduler started (every 60s)");
}

export function stopConnectorScheduler(): void {
  if (sched.timer) clearInterval(sched.timer);
  sched.timer = undefined;
  sched.started = false;
}
