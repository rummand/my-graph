/**
 * The in-process timing collector (pure). Every finished request adds one sample to the cell for its minute, route
 * and method; `drain()` hands the cells over (for the database, once a minute) and starts afresh. Only route patterns,
 * methods, durations and status codes are kept: no URLs, query strings, users or content.
 */
import { addHist, bucketOf, emptyHist } from "./histogram";

export type Sample = {
  /** A route pattern such as "/people/[id]" (normalizeRoute is applied again here). */
  route: string;
  /** "GET", "POST", … or "RSC" for in-app navigations. */
  method: string;
  ms: number;
  status: number;
  /** When it finished (epoch ms); defaults to now. */
  at?: number;
};

export type TimingRow = {
  bucket: Date;
  route: string;
  method: string;
  count: number;
  errors: number;
  slow: number;
  sumMs: number;
  maxMs: number;
  hist: number[];
};

export const MINUTE_MS = 60_000;
export const OTHER_ROUTE = "(other)";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LONG_ID = /^(?=.*\d)[A-Za-z0-9_-]{16,}$/;

/**
 * A route pattern from whatever we were given: Next's own pattern passes through; a concrete path loses its query
 * string and fragment, and ids (UUIDs, numbers, long tokens) become "[id]". Capped at 200 characters.
 */
export function normalizeRoute(input: string | null | undefined): string {
  if (!input) return OTHER_ROUTE;
  let p = String(input).split(/[?#]/)[0] || "/";
  if (!p.startsWith("/")) p = `/${p}`;
  p = p.split("/").map((seg) => (UUID.test(seg) || /^\d+$/.test(seg) || LONG_ID.test(seg) ? "[id]" : seg)).join("/");
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  // Next names route handlers by their file ("/api/library/route"); show the address part.
  if (/\/route$/.test(p) && p.startsWith("/api/")) p = p.slice(0, -"/route".length);
  return p.slice(0, 200);
}

export function normalizeMethod(m: string | null | undefined): string {
  const up = String(m ?? "").toUpperCase();
  return /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|RSC)$/.test(up) ? up : "OTHER";
}

type Cell = TimingRow;

export class TimingCollector {
  private cells = new Map<string, Cell>();
  private routes = new Set<string>();

  constructor(private readonly opts: { maxRoutes?: number; slowMs?: number; maxCells?: number } = {}) {}

  get slowMs(): number {
    return this.opts.slowMs ?? 2000;
  }

  /** Number of (minute, route, method) cells waiting to be drained. */
  get size(): number {
    return this.cells.size;
  }

  record(s: Sample): void {
    if (!Number.isFinite(s.ms) || s.ms < 0) return;
    const at = s.at ?? Date.now();
    const bucket = Math.floor(at / MINUTE_MS) * MINUTE_MS;
    let route = normalizeRoute(s.route);
    // A runaway number of distinct routes (e.g. a bug that leaks ids into patterns) folds into one row.
    if (!this.routes.has(route)) {
      if (this.routes.size >= (this.opts.maxRoutes ?? 300)) route = OTHER_ROUTE;
      else this.routes.add(route);
    }
    const method = normalizeMethod(s.method);
    const key = `${bucket}|${method}|${route}`;
    let c = this.cells.get(key);
    if (!c) {
      c = { bucket: new Date(bucket), route, method, count: 0, errors: 0, slow: 0, sumMs: 0, maxMs: 0, hist: emptyHist() };
      this.cells.set(key, c);
    }
    const ms = Math.round(s.ms);
    c.count += 1;
    c.sumMs += ms;
    c.maxMs = Math.max(c.maxMs, ms);
    c.hist[bucketOf(ms)] += 1;
    if (s.status >= 500) c.errors += 1;
    if (ms >= this.slowMs) c.slow += 1;
  }

  /** Everything collected so far, oldest minute first; the collector is empty afterwards. */
  drain(): TimingRow[] {
    const rows = [...this.cells.values()].sort((a, b) => a.bucket.getTime() - b.bucket.getTime() || a.route.localeCompare(b.route));
    this.cells = new Map();
    this.routes = new Set();
    return rows;
  }

  /** Put rows back after a failed flush (merged into whatever arrived meanwhile), so a database hiccup loses nothing. */
  restore(rows: TimingRow[]): void {
    for (const r of rows) {
      const key = `${r.bucket.getTime()}|${r.method}|${r.route}`;
      const c = this.cells.get(key);
      this.routes.add(r.route);
      if (!c) { this.cells.set(key, { ...r, hist: [...r.hist] }); continue; }
      c.count += r.count; c.errors += r.errors; c.slow += r.slow; c.sumMs += r.sumMs;
      c.maxMs = Math.max(c.maxMs, r.maxMs); c.hist = addHist(c.hist, r.hist);
    }
    // While the database stays away, keep the newest cells only (bounded memory).
    const cap = this.opts.maxCells ?? 20_000;
    if (this.cells.size > cap) {
      const keep = [...this.cells.entries()].sort((a, b) => b[1].bucket.getTime() - a[1].bucket.getTime()).slice(0, cap);
      this.cells = new Map(keep);
    }
  }
}
