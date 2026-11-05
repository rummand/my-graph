/**
 * Request timings from Next.js's own tracing (server-only, Node). Next wraps every request in an OpenTelemetry span
 * ("BaseServer.handleRequest") and, once the route is known, names it "GET /people/[id]". Normally nobody listens.
 * Here a minimal tracer provider and an AsyncLocalStorage context manager are put on the OpenTelemetry global, so we
 * hear when each request span ends: its route pattern, method, status and duration. Nothing else is read.
 *
 * Stays out of the way: if the app already has an OpenTelemetry SDK (a tracer provider or context manager on the
 * global), this does nothing and timings simply aren't collected. No dependency is imported: the global registry
 * is a documented contract (`Symbol.for("opentelemetry.js.api.1")`), and contexts are keyed by `Symbol.for(...)`.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

/**
 * The API version we register as. Consumers accept a global whose minor version is at least their own, so this must
 * be >= the @opentelemetry/api Next.js loads (a test checks it against node_modules).
 */
export const OTEL_API_VERSION = "1.10.0";
const GLOBAL_KEY = Symbol.for("opentelemetry.js.api.1");
const SPAN_KEY = Symbol.for("OpenTelemetry Context Key SPAN");
const ROOT_SPAN_TYPE = "BaseServer.handleRequest";

export type RequestEnd = {
  /** Route pattern ("/people/[id]") or null when Next didn't resolve one (static files, unmatched paths). */
  route: string | null;
  method: string;
  status: number;
  rsc: boolean;
  ms: number;
  /** An error was reported for this request through captureInRequest (so a 500 isn't counted twice). */
  errored: boolean;
};

type Attr = string | number | boolean | undefined;

/* ── Context ─────────────────────────────────────────────────────────────────────────────────────────────────────── */

class Ctx {
  constructor(private readonly values: Map<symbol, unknown> = new Map()) {}
  getValue(key: symbol): unknown {
    return this.values.get(key);
  }
  setValue(key: symbol, value: unknown): Ctx {
    const m = new Map(this.values);
    m.set(key, value);
    return new Ctx(m);
  }
  deleteValue(key: symbol): Ctx {
    const m = new Map(this.values);
    m.delete(key);
    return new Ctx(m);
  }
}
const ROOT = new Ctx();

type AnyCtx = { getValue(k: symbol): unknown; setValue(k: symbol, v: unknown): AnyCtx };

class AlsContextManager {
  private als = new AsyncLocalStorage<AnyCtx>();
  active(): AnyCtx {
    return this.als.getStore() ?? ROOT;
  }
  with<A extends unknown[], R>(ctx: AnyCtx, fn: (...args: A) => R, thisArg?: unknown, ...args: A): R {
    const cb = thisArg == null ? fn : fn.bind(thisArg);
    return this.als.run(ctx ?? ROOT, cb, ...args);
  }
  bind<T>(ctx: AnyCtx, target: T): T {
    if (typeof target !== "function") return target;
    const run = this.with.bind(this);
    const fn = target as unknown as (...a: unknown[]) => unknown;
    return function (this: unknown, ...a: unknown[]) {
      return run(ctx, () => fn.apply(this, a));
    } as unknown as T;
  }
  enable(): this {
    return this;
  }
  disable(): this {
    this.als.disable();
    return this;
  }
}

/* ── Spans ───────────────────────────────────────────────────────────────────────────────────────────────────────── */

class Span {
  private attrs = new Map<string, Attr>();
  private ended = false;
  private readonly start = performance.now();
  private readonly ctx = { traceId: randomBytes(16).toString("hex"), spanId: randomBytes(8).toString("hex"), traceFlags: 1 };
  errored = false;

  constructor(public name: string, readonly root: Span | null, attributes: Record<string, Attr> | undefined, private readonly onEnd: (s: Span, ms: number) => void) {
    for (const [k, v] of Object.entries(attributes ?? {})) this.attrs.set(k, v);
  }
  attr(k: string): Attr {
    return this.attrs.get(k);
  }
  spanContext() {
    return this.ctx;
  }
  setAttribute(k: string, v: Attr) {
    this.attrs.set(k, v);
    return this;
  }
  setAttributes(a: Record<string, Attr>) {
    for (const [k, v] of Object.entries(a ?? {})) this.attrs.set(k, v);
    return this;
  }
  addEvent() {
    return this;
  }
  addLink() {
    return this;
  }
  addLinks() {
    return this;
  }
  setStatus() {
    return this;
  }
  updateName(n: string) {
    this.name = n;
    return this;
  }
  recordException() {
    (this.root ?? this).errored = true;
  }
  isRecording() {
    return !this.ended;
  }
  end() {
    if (this.ended) return;
    this.ended = true;
    this.onEnd(this, performance.now() - this.start);
  }
}

class Tracer {
  constructor(private readonly cm: AlsContextManager, private readonly onEnd: (s: Span, ms: number) => void) {}

  startSpan(name: string, options?: { attributes?: Record<string, Attr>; root?: boolean }, ctx?: AnyCtx): Span {
    const parent = options?.root ? undefined : ((ctx ?? this.cm.active()).getValue(SPAN_KEY) as Span | undefined);
    const root = parent instanceof Span ? parent.root ?? parent : null;
    return new Span(name, root, options?.attributes, this.onEnd);
  }

  startActiveSpan<R>(name: string, fn: (span: Span) => R): R;
  startActiveSpan<R>(name: string, options: { attributes?: Record<string, Attr> } | undefined, fn: (span: Span) => R): R;
  startActiveSpan<R>(name: string, options: { attributes?: Record<string, Attr> } | undefined, ctx: AnyCtx | undefined, fn: (span: Span) => R): R;
  startActiveSpan(name: string, ...rest: unknown[]): unknown {
    const fn = rest[rest.length - 1] as (span: Span) => unknown;
    const options = (rest.length >= 2 ? rest[0] : undefined) as { attributes?: Record<string, Attr> } | undefined;
    const ctx = (rest.length >= 3 ? rest[1] : undefined) as AnyCtx | undefined;
    const parentCtx = ctx ?? this.cm.active();
    const span = this.startSpan(name, options, parentCtx);
    return this.cm.with(parentCtx.setValue(SPAN_KEY, span), fn, undefined, span);
  }
}

/* ── Registration ────────────────────────────────────────────────────────────────────────────────────────────────── */

type Registry = { version?: string; trace?: unknown; context?: unknown; __myGraphTimer?: boolean };

let manager: AlsContextManager | null = null;

/**
 * Listen for the end of every request span. Returns false (and changes nothing) when another OpenTelemetry setup
 * already owns the global. Safe to call more than once: only the first registration in a process counts.
 */
export function registerRequestTimer(onRequestEnd: (r: RequestEnd) => void): boolean {
  const g = globalThis as unknown as Record<symbol, Registry | undefined>;
  const existing = g[GLOBAL_KEY];
  if (existing?.__myGraphTimer) return true;
  if (existing && (existing.trace || existing.context)) return false;

  const cm = new AlsContextManager();
  const onEnd = (s: Span, ms: number) => {
    if (s.root || s.attr("next.span_type") !== ROOT_SPAN_TYPE) return;
    try {
      const route = s.attr("next.route");
      onRequestEnd({
        route: typeof route === "string" ? route : null,
        method: String(s.attr("http.method") ?? "GET"),
        status: Number(s.attr("http.status_code") ?? 200),
        rsc: s.attr("next.rsc") === true,
        ms,
        errored: s.errored,
      });
    } catch {
      // Never let observability break a request.
    }
  };
  const tracer = new Tracer(cm, onEnd);
  const provider = { getTracer: () => tracer };
  const traceApi = provider;
  const registry: Registry = existing ?? { version: OTEL_API_VERSION };
  registry.trace = traceApi;
  registry.context = cm;
  registry.__myGraphTimer = true;
  if (!existing) g[GLOBAL_KEY] = registry;
  manager = cm;
  return true;
}

/** Mark the request running in this async context as having reported an error (see RequestEnd.errored). */
export function markRequestErrored(): void {
  const span = manager?.active().getValue(SPAN_KEY);
  if (span instanceof Span) (span.root ?? span).errored = true;
}

/** For tests: the pieces, without touching the global. */
export const __test = { AlsContextManager, Tracer, Span, SPAN_KEY, ROOT_SPAN_TYPE };
