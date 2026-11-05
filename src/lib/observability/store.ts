/**
 * Observability storage (server-only): writes the collector's minutes and folded error groups, prunes old rows, and
 * reads them back for the Admin "Errors" and "Performance" pages. Metadata only (see errors.ts and collector.ts).
 */
import { and, asc, desc, eq, gte, isNull, isNotNull, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { routeTimings, serverErrors, sessions } from "@/db/schema";
import { hashToken, isWellFormedToken, SESSION_COOKIE } from "@/lib/auth/session";
import type { TimingRow } from "./collector";
import type { ErrorAgg, ErrorKind } from "./errors";
import { BUCKETS, quantileOf } from "./histogram";

export const TIMINGS_KEEP_DAYS = 14;
export const ERRORS_KEEP_DAYS = 90;

/** Add minutes of timings; a minute flushed twice (two processes, or a retry) adds up instead of overwriting. */
export async function writeTimings(rows: TimingRow[]): Promise<void> {
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    await db.insert(routeTimings).values(chunk.map((r) => ({
      bucket: r.bucket, route: r.route, method: r.method, count: r.count, errors: r.errors, slow: r.slow,
      sumMs: Math.min(r.sumMs, 2_000_000_000), maxMs: Math.min(r.maxMs, 2_000_000_000), hist: r.hist,
    }))).onConflictDoUpdate({
      target: [routeTimings.bucket, routeTimings.route, routeTimings.method],
      set: {
        count: sql`${routeTimings.count} + excluded.count`,
        errors: sql`${routeTimings.errors} + excluded.errors`,
        slow: sql`${routeTimings.slow} + excluded.slow`,
        sumMs: sql`least(${routeTimings.sumMs}::bigint + excluded.sum_ms, 2000000000)::int`,
        maxMs: sql`greatest(${routeTimings.maxMs}, excluded.max_ms)`,
        hist: sql`(select array_agg(coalesce(a, 0) + coalesce(b, 0) order by i) from unnest(${routeTimings.hist}, excluded.hist) with ordinality as t(a, b, i))`,
      },
    });
  }
}

/** Upsert folded error groups. A group that comes back after being marked resolved opens again. */
export async function writeErrors(groups: ErrorAgg[]): Promise<void> {
  for (const g of groups) {
    const e = g.event;
    await db.insert(serverErrors).values({
      fingerprint: e.fingerprint, kind: e.kind, name: e.name, message: e.message, stackHash: e.stackHash, frames: e.frames,
      route: e.route, method: e.method, source: e.source, status: e.status, digest: e.digest, count: g.count,
      userHashes: [...g.userHashes], lastDurationMs: e.durationMs, maxDurationMs: g.maxDurationMs, firstSeenAt: e.at, lastSeenAt: e.at,
    }).onConflictDoUpdate({
      target: serverErrors.fingerprint,
      set: {
        count: sql`${serverErrors.count} + excluded.count`,
        message: sql`excluded.message`,
        frames: sql`excluded.frames`,
        status: sql`excluded.status`,
        digest: sql`coalesce(excluded.digest, ${serverErrors.digest})`,
        source: sql`excluded.source`,
        lastDurationMs: sql`coalesce(excluded.last_duration_ms, ${serverErrors.lastDurationMs})`,
        maxDurationMs: sql`greatest(${serverErrors.maxDurationMs}, excluded.max_duration_ms)`,
        lastSeenAt: sql`greatest(${serverErrors.lastSeenAt}, excluded.last_seen_at)`,
        resolvedAt: sql`null`,
        userHashes: sql`coalesce((select jsonb_agg(x) from (select distinct x from jsonb_array_elements_text(${serverErrors.userHashes} || excluded.user_hashes) as x limit 50) s), '[]'::jsonb)`,
      },
    });
  }
}

export async function pruneObservability(now = new Date()): Promise<void> {
  await db.delete(routeTimings).where(lt(routeTimings.bucket, new Date(now.getTime() - TIMINGS_KEEP_DAYS * 86400_000)));
  await db.delete(serverErrors).where(lt(serverErrors.lastSeenAt, new Date(now.getTime() - ERRORS_KEEP_DAYS * 86400_000)));
}

/** The account behind a request's session cookie (for the hashed user count), or null. Never stores the token. */
export async function userIdFromCookieHeader(cookie: string | string[] | undefined | null): Promise<string | null> {
  const header = Array.isArray(cookie) ? cookie.join("; ") : cookie ?? "";
  const m = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`).exec(header);
  const token = m ? decodeURIComponent(m[1]) : null;
  if (!isWellFormedToken(token)) return null;
  const [row] = await db.select({ userId: sessions.userId }).from(sessions).where(eq(sessions.tokenHash, hashToken(token))).limit(1);
  return row?.userId ?? null;
}

/* ── Reads for the admin console ─────────────────────────────────────────────────────────────────────────────────── */

export type ErrorGroupView = {
  id: string; kind: ErrorKind; name: string; message: string; route: string; method: string; source: string; status: number | null;
  count: number; users: number; firstSeenAt: Date; lastSeenAt: Date; resolvedAt: Date | null; lastDurationMs: number | null;
  maxDurationMs: number | null; frames: string[]; stackHash: string; digest: string | null;
};

export async function listErrorGroups(opts: { kind?: ErrorKind | "all"; state?: "open" | "resolved" | "all"; limit?: number } = {}): Promise<ErrorGroupView[]> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const rows = await db.select().from(serverErrors).where(and(
    opts.kind && opts.kind !== "all" ? eq(serverErrors.kind, opts.kind) : undefined,
    opts.state === "resolved" ? isNotNull(serverErrors.resolvedAt) : opts.state === "all" ? undefined : isNull(serverErrors.resolvedAt),
  )).orderBy(desc(serverErrors.lastSeenAt)).limit(limit);
  return rows.map((r) => ({
    id: r.id, kind: r.kind as ErrorKind, name: r.name, message: r.message, route: r.route, method: r.method, source: r.source,
    status: r.status, count: r.count, users: (r.userHashes ?? []).length, firstSeenAt: r.firstSeenAt, lastSeenAt: r.lastSeenAt,
    resolvedAt: r.resolvedAt, lastDurationMs: r.lastDurationMs, maxDurationMs: r.maxDurationMs, frames: r.frames ?? [],
    stackHash: r.stackHash, digest: r.digest,
  }));
}

export async function errorCounts(): Promise<{ open: number; resolved: number; last24h: number }> {
  const since = new Date(Date.now() - 86400_000);
  const [r] = await db.select({
    open: sql<number>`count(*) filter (where ${serverErrors.resolvedAt} is null)`.mapWith(Number),
    resolved: sql<number>`count(*) filter (where ${serverErrors.resolvedAt} is not null)`.mapWith(Number),
    last24h: sql<number>`count(*) filter (where ${serverErrors.lastSeenAt} >= ${since.toISOString()})`.mapWith(Number),
  }).from(serverErrors);
  return r ?? { open: 0, resolved: 0, last24h: 0 };
}

/** Mark a group resolved (or open again). Returns false when there's no such group. */
export async function setErrorResolved(id: string, resolved: boolean): Promise<boolean> {
  const r = await db.update(serverErrors).set({ resolvedAt: resolved ? new Date() : null }).where(eq(serverErrors.id, id)).returning({ id: serverErrors.id });
  return r.length > 0;
}

export type RoutePerf = {
  route: string; method: string; count: number; errors: number; slow: number; avgMs: number; p50Ms: number | null; p95Ms: number | null; maxMs: number;
};
export type PerfSummary = { since: Date; routes: RoutePerf[]; total: Omit<RoutePerf, "route" | "method"> };

/** Route timings since a moment: p50/p95 per route from summed histograms, plus the total. */
export async function routePerformance(since: Date): Promise<PerfSummary> {
  const where = gte(routeTimings.bucket, since);
  const [agg, hists] = await Promise.all([
    db.select({
      route: routeTimings.route, method: routeTimings.method,
      count: sql<number>`sum(${routeTimings.count})`.mapWith(Number), errors: sql<number>`sum(${routeTimings.errors})`.mapWith(Number),
      slow: sql<number>`sum(${routeTimings.slow})`.mapWith(Number), sumMs: sql<number>`sum(${routeTimings.sumMs}::bigint)`.mapWith(Number),
      maxMs: sql<number>`max(${routeTimings.maxMs})`.mapWith(Number),
    }).from(routeTimings).where(where).groupBy(routeTimings.route, routeTimings.method),
    db.execute<{ route: string; method: string; i: number; n: number }>(sql`
      select t.route, t.method, u.i::int as i, sum(u.n)::int as n
      from ${routeTimings} t, unnest(t.hist) with ordinality as u(n, i)
      where t.bucket >= ${since.toISOString()}
      group by t.route, t.method, u.i`),
  ]);
  const histOf = new Map<string, number[]>();
  for (const h of hists as unknown as { route: string; method: string; i: number; n: number }[]) {
    const k = `${h.method} ${h.route}`;
    const arr = histOf.get(k) ?? new Array(BUCKETS).fill(0);
    if (h.i >= 1 && h.i <= BUCKETS) arr[h.i - 1] += Number(h.n);
    histOf.set(k, arr);
  }
  const all = new Array(BUCKETS).fill(0);
  let tc = 0, te = 0, ts = 0, tsum = 0, tmax = 0;
  const routes: RoutePerf[] = agg.map((r) => {
    const hist = histOf.get(`${r.method} ${r.route}`) ?? new Array(BUCKETS).fill(0);
    hist.forEach((n, i) => { all[i] += n; });
    tc += r.count; te += r.errors; ts += r.slow; tsum += r.sumMs; tmax = Math.max(tmax, r.maxMs);
    return {
      route: r.route, method: r.method, count: r.count, errors: r.errors, slow: r.slow, maxMs: r.maxMs,
      avgMs: r.count ? Math.round(r.sumMs / r.count) : 0, p50Ms: quantileOf(hist, 0.5, r.maxMs), p95Ms: quantileOf(hist, 0.95, r.maxMs),
    };
  }).sort((a, b) => (b.p95Ms ?? 0) - (a.p95Ms ?? 0) || b.count - a.count);

  return {
    since, routes,
    total: { count: tc, errors: te, slow: ts, maxMs: tmax, avgMs: tc ? Math.round(tsum / tc) : 0, p50Ms: quantileOf(all, 0.5, tmax), p95Ms: quantileOf(all, 0.95, tmax) },
  };
}

/** The oldest minute on record (for "collected since"). */
export async function timingsSince(): Promise<Date | null> {
  const [r] = await db.select({ at: routeTimings.bucket }).from(routeTimings).orderBy(asc(routeTimings.bucket)).limit(1);
  return r?.at ?? null;
}
