/**
 * One rate limiter for the whole app, shared by every server process through Postgres (`rate_limits`), with an
 * in-memory copy as a cache in front of it (server-only). Used by the MCP server, MCP tool approvals, dictation,
 * paste and sign-in.
 *
 * How it counts: fixed windows of `windowMs`, one row per (bucket, key, window start), bumped with one atomic
 * INSERT … ON CONFLICT … RETURNING. A request is judged on a sliding estimate: this window's count plus the share of the
 * last window that still overlaps (the usual "sliding window counter"), so a burst at a window edge can't double the
 * limit.
 *
 * The cache: once a key is over its limit in a window, this process refuses it without asking the database again
 * until that window ends (the count only grows inside a window). When the database can't be reached, the in-memory
 * counter decides on its own, so the app keeps limiting (per process) instead of failing open or failing closed.
 *
 * Keys are hashed before they are stored (IPs, e-mail addresses and credential ids never reach the table). Expired
 * rows are swept now and then on use.
 */
import { createHash } from "node:crypto";
import { lt, and, eq, inArray, sql as dsql } from "drizzle-orm";
import { db } from "@/db";
import { rateLimits } from "@/db/schema";

export type Limit = {
  /** What is being limited ("mcp", "transcribe", "login.ip", …). */
  bucket: string;
  /** How many in one window. */
  limit: number;
  windowMs: number;
};

export type Verdict = { allowed: true; remaining: number } | { allowed: false; retryAfterSec: number };

/** Where window counts live: Postgres in the app, a map in the tests. */
export interface CountStore {
  /** Add `by` to the window's count and return the new count. */
  add(bucket: string, key: string, windowStart: number, expiresAt: number, by: number): Promise<number>;
  /** The counts of these windows (missing = 0). */
  read(bucket: string, key: string, windowStarts: number[]): Promise<Map<number, number>>;
  /** Forget every window of this key. */
  clear(bucket: string, key: string): Promise<void>;
  /** Remove windows that have ended. */
  sweep(now: number): Promise<void>;
}

/** Hash a key so nothing personal is stored or kept in memory longer than needed. */
export function hashKey(key: string): string {
  return createHash("sha256").update(`mg-rate|${key}`).digest("base64url").slice(0, 32);
}

export const windowStartOf = (now: number, windowMs: number) => Math.floor(now / windowMs) * windowMs;

/**
 * The sliding estimate (pure): this window's count plus the overlapping share of the previous one, and, when it is
 * over the limit, how long until it would be back under.
 */
export function judge(limit: Pick<Limit, "limit" | "windowMs">, now: number, current: number, previous: number): Verdict {
  const start = windowStartOf(now, limit.windowMs);
  const elapsed = (now - start) / limit.windowMs;
  const weight = 1 - elapsed;
  const estimate = current + previous * weight;
  if (estimate <= limit.limit) return { allowed: true, remaining: Math.max(0, Math.floor(limit.limit - estimate)) };
  // Over: the earliest the estimate drops back to the limit. Within this window only the previous share shrinks; if
  // that isn't enough, wait for the next window (where this window becomes the previous one).
  let waitMs: number;
  if (current <= limit.limit && previous > 0) {
    // current + previous * (1 - (t - start)/W) <= limit  →  t >= start + W * (1 - (limit - current) / previous)
    const t = start + limit.windowMs * (1 - (limit.limit - current) / previous);
    waitMs = Math.max(0, t - now);
  } else {
    const next = start + limit.windowMs;
    // In the next window: 0 + current * (1 - (t - next)/W) <= limit  →  t >= next + W * (1 - limit/current)
    waitMs = next - now + Math.max(0, limit.windowMs * (1 - limit.limit / Math.max(current, 1)));
  }
  return { allowed: false, retryAfterSec: Math.max(1, Math.ceil(waitMs / 1000)) };
}

/* ── Stores ──────────────────────────────────────────────────────────────────────────────────────────── */

export function memoryCountStore(): CountStore & { size(): number } {
  const m = new Map<string, { n: number; exp: number }>();
  const id = (b: string, k: string, w: number) => `${b}\u0000${k}\u0000${w}`;
  return {
    async add(b, k, w, exp, by) {
      const cur = m.get(id(b, k, w));
      const n = (cur?.n ?? 0) + by;
      m.set(id(b, k, w), { n, exp });
      return n;
    },
    async read(b, k, ws) {
      return new Map(ws.map((w) => [w, m.get(id(b, k, w))?.n ?? 0]));
    },
    async clear(b, k) {
      const prefix = `${b}\u0000${k}\u0000`;
      for (const key of [...m.keys()]) if (key.startsWith(prefix)) m.delete(key);
    },
    async sweep(now) {
      for (const [key, v] of m) if (v.exp <= now) m.delete(key);
    },
    size: () => m.size,
  };
}

export const dbCountStore: CountStore = {
  async add(bucket, key, windowStart, expiresAt, by) {
    const [r] = await db.insert(rateLimits)
      .values({ bucket, key, windowStart: new Date(windowStart), count: by, expiresAt: new Date(expiresAt) })
      .onConflictDoUpdate({ target: [rateLimits.bucket, rateLimits.key, rateLimits.windowStart], set: { count: dsql`${rateLimits.count} + ${by}` } })
      .returning({ count: rateLimits.count });
    return r?.count ?? by;
  },
  async read(bucket, key, windowStarts) {
    const rows = await db.select({ w: rateLimits.windowStart, n: rateLimits.count }).from(rateLimits)
      .where(and(eq(rateLimits.bucket, bucket), eq(rateLimits.key, key), inArray(rateLimits.windowStart, windowStarts.map((w) => new Date(w)))));
    const out = new Map<number, number>(windowStarts.map((w) => [w, 0]));
    for (const r of rows) out.set(r.w.getTime(), r.n);
    return out;
  },
  async clear(bucket, key) {
    await db.delete(rateLimits).where(and(eq(rateLimits.bucket, bucket), eq(rateLimits.key, key)));
  },
  async sweep(now) {
    await db.delete(rateLimits).where(lt(rateLimits.expiresAt, new Date(now)));
  },
};

/* ── The limiter ─────────────────────────────────────────────────────────────────────────────────────── */

export type LimiterOptions = { store?: CountStore; now?: () => number; cache?: CountStore; onStoreError?: (e: unknown) => void };

export class RateLimiter {
  private readonly store: CountStore;
  private readonly cache: CountStore;
  private readonly now: () => number;
  /** Keys this process already knows are over the limit in a window, with the counts it saw then. */
  private readonly blocked = new Map<string, { w: number; current: number; previous: number }>();
  private lastSweep = 0;
  private readonly onStoreError: (e: unknown) => void;

  constructor(opts: LimiterOptions = {}) {
    this.store = opts.store ?? dbCountStore;
    this.cache = opts.cache ?? memoryCountStore();
    this.now = opts.now ?? Date.now;
    this.onStoreError = opts.onStoreError ?? ((e) => { console.warn("[rate-limit] database unavailable, limiting in memory:", e instanceof Error ? e.message : e); });
  }

  /** Count one request and say whether it may go ahead. A refused request still counts (so hammering stays refused). */
  async hit(limit: Limit, rawKey: string, by = 1): Promise<Verdict> {
    return this.count(limit, rawKey, by, true);
  }

  /** Whether one more would be allowed, without counting (sign-in: check first, count only failures). */
  async check(limit: Limit, rawKey: string): Promise<Verdict> {
    return this.count(limit, rawKey, 0, false);
  }

  /** Count one (a failed sign-in) without judging it. */
  async fail(limit: Limit, rawKey: string): Promise<void> {
    await this.count(limit, rawKey, 1, false);
  }

  /** Forget a key (a successful sign-in clears its failures). */
  async reset(limit: Limit, rawKey: string): Promise<void> {
    const key = hashKey(rawKey);
    this.blocked.delete(`${limit.bucket}|${key}`);
    await this.cache.clear(limit.bucket, key);
    await this.store.clear(limit.bucket, key).catch((e) => this.onStoreError(e));
  }

  private async count(limit: Limit, rawKey: string, by: number, judgeAfter: boolean): Promise<Verdict> {
    const now = this.now();
    const key = hashKey(rawKey);
    const w = windowStartOf(now, limit.windowMs);
    const prev = w - limit.windowMs;
    const exp = w + 2 * limit.windowMs; // kept one more window, as the "previous" of the next
    const tag = `${limit.bucket}|${key}`;
    const verdictOf = (current: number, previous: number) => judge(limit, now, current + (judgeAfter ? 0 : 1), previous);

    // Fast path: already over in this window, known here. The count only grows inside a window, so the answer stays
    // "no" until the estimate drops; it is worked out from the snapshot without asking the database.
    const snap = this.blocked.get(tag);
    if (snap && snap.w === w) {
      snap.current += by;
      const v = verdictOf(snap.current, snap.previous);
      if (!v.allowed) return v;
      this.blocked.delete(tag); // the previous window's share has worn off: ask the database again next time
    }

    let current: number, previous: number;
    try {
      if (by > 0) current = await this.store.add(limit.bucket, key, w, exp, by);
      else current = (await this.store.read(limit.bucket, key, [w])).get(w) ?? 0;
      previous = (await this.store.read(limit.bucket, key, [prev])).get(prev) ?? 0;
      // Keep the cache in step so it can take over if the database goes away.
      if (by > 0) await this.cache.add(limit.bucket, key, w, exp, by);
      if (now - this.lastSweep > 5 * 60_000) {
        this.lastSweep = now;
        void this.store.sweep(now).catch(() => {});
        void this.cache.sweep(now);
      }
    } catch (e) {
      this.onStoreError(e);
      current = by > 0 ? await this.cache.add(limit.bucket, key, w, exp, by) : (await this.cache.read(limit.bucket, key, [w])).get(w) ?? 0;
      previous = (await this.cache.read(limit.bucket, key, [prev])).get(prev) ?? 0;
    }
    const v = verdictOf(current, previous);
    if (!v.allowed) {
      // A check judges "one more"; store the counted value so later hits and checks judge from the same base.
      this.blocked.set(tag, { w, current, previous });
      if (this.blocked.size > 10_000) for (const [k, b] of this.blocked) if (b.w < w) this.blocked.delete(k);
    }
    return v;
  }
}

const g = globalThis as unknown as { __mgRateLimiter?: RateLimiter };
/** The app's limiter (Postgres behind an in-memory cache). */
export function limiter(): RateLimiter {
  return (g.__mgRateLimiter ??= new RateLimiter());
}
