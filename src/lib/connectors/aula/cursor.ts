/**
 * Cursors for Aula, pure.
 *
 * Threads. Aula lists threads newest activity first, 20 a page. The cursor remembers the newest message time that is
 * completely stored (`latestMessageAt`) and, per thread, the newest message time stored for it. A run pages until it
 * reaches a thread whose latest activity is at or before `latestMessageAt` (everything older is unchanged) or the
 * start date, then reads the changed threads oldest first, a limited number per run. `latestMessageAt` only moves
 * when a run saw the whole changed range, so a run cut short never skips anything; the per-thread times and the
 * stored message ids (dedupe by aula:msg:<id>) keep a re-read from doubling anything.
 *
 * Calendar. Aula answers a bounded range per call: we ask in windows of 49 days, from a week back to 13 weeks ahead,
 * in Aula's own time format (Europe/Copenhagen wall-clock, `YYYY-MM-DD HH:MM:SS.0000+ZZZZ`; aulaTs follows aula-mcp's
 * calendar-range.ts, MIT, see LICENSE-aula-mcp.txt).
 */
import type { AulaMessage, AulaThread } from "./mapping";

export type ThreadsCursor = { latestMessageAt?: string | null; threads?: Record<string, string> };

export const THREADS_PER_RUN = 40;
export const MAX_THREAD_PAGES = 10;
export const MAX_MESSAGE_PAGES = 5;
/** Per-thread memory is kept for threads active in the last 120 days; older ones are re-checked by message id. */
const KEEP_MS = 120 * 24 * 3600_000;

/** Is this thread worth reading (new activity since we last stored it)? */
export function threadChanged(t: Pick<AulaThread, "id" | "latestAt">, cur: ThreadsCursor): boolean {
  const known = cur.threads?.[t.id];
  if (!t.latestAt) return !known;
  if (!known) return !cur.latestMessageAt || t.latestAt.getTime() > Date.parse(cur.latestMessageAt);
  return t.latestAt.getTime() > Date.parse(known);
}

/**
 * Look at one page: which threads changed, and whether paging can stop here (an unchanged thread older than the
 * cursor, or a thread older than the start date, means every later page is older still).
 */
export function scanPage(page: AulaThread[], cur: ThreadsCursor, since: Date): { changed: AulaThread[]; stop: boolean } {
  const changed: AulaThread[] = [];
  const floor = cur.latestMessageAt ? Date.parse(cur.latestMessageAt) : null;
  for (const t of page) {
    const at = t.latestAt?.getTime() ?? null;
    if (at !== null && at < since.getTime()) return { changed, stop: true };
    if (threadChanged(t, cur)) { changed.push(t); continue; }
    if (floor !== null && at !== null && at <= floor) return { changed, stop: true };
  }
  return { changed, stop: false };
}

/** Changed threads in the order they are read: oldest activity first, at most `max`. */
export function planThreads(changed: AulaThread[], max = THREADS_PER_RUN): { take: AulaThread[]; more: boolean } {
  const unique = [...new Map(changed.map((t) => [t.id, t])).values()];
  const ordered = unique.sort((a, b) => (a.latestAt?.getTime() ?? 0) - (b.latestAt?.getTime() ?? 0) || a.id.localeCompare(b.id));
  return { take: ordered.slice(0, max), more: ordered.length > max };
}

/** The messages of a page that are newer than what we stored for the thread (all of them for a new thread). */
export function newMessages(messages: AulaMessage[], knownAt: string | undefined): { fresh: AulaMessage[]; reachedKnown: boolean } {
  const floor = knownAt ? Date.parse(knownAt) : null;
  const fresh: AulaMessage[] = [];
  let reachedKnown = false;
  for (const m of messages) {
    if (floor !== null && m.at && m.at.getTime() <= floor) { reachedKnown = true; continue; }
    fresh.push(m);
  }
  return { fresh, reachedKnown };
}

/** After one thread is stored: remember its newest message time. */
export function afterThread(cur: ThreadsCursor, t: Pick<AulaThread, "id" | "latestAt">, stored: AulaMessage[]): ThreadsCursor {
  const times = [t.latestAt?.getTime() ?? 0, ...stored.map((m) => m.at?.getTime() ?? 0), cur.threads?.[t.id] ? Date.parse(cur.threads[t.id]) : 0];
  const newest = Math.max(...times);
  return { ...cur, threads: { ...(cur.threads ?? {}), [t.id]: new Date(newest || Date.now()).toISOString() } };
}

/**
 * At the end of a run: move `latestMessageAt` to the newest activity seen, but only when the run read the whole
 * changed range (paging stopped by itself and nothing was left for the next run). Old per-thread entries are dropped.
 */
export function finishThreads(cur: ThreadsCursor, seen: AulaThread[], complete: boolean, now: Date): ThreadsCursor {
  let latest = cur.latestMessageAt ?? null;
  if (complete) {
    const newest = Math.max(latest ? Date.parse(latest) : 0, ...seen.map((t) => t.latestAt?.getTime() ?? 0));
    latest = newest > 0 ? new Date(newest).toISOString() : latest;
  }
  const keepFrom = now.getTime() - KEEP_MS;
  const threads = Object.fromEntries(Object.entries(cur.threads ?? {}).filter(([, at]) => Date.parse(at) >= keepFrom));
  return { latestMessageAt: latest, threads };
}

/* ── Posts ─────────────────────────────────────────────────────────────────────────────────────────── */

export type PostsCursor = { newestAt?: string | null };

/* ── Calendar windows ──────────────────────────────────────────────────────────────────────────────── */

export const CALENDAR_WINDOW_DAYS = 49;

/** Minutes east of UTC that Copenhagen has at this instant. */
export function copenhagenOffsetMinutes(d: Date): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Copenhagen", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  let diff = h * 60 + m - (d.getUTCHours() * 60 + d.getUTCMinutes());
  if (diff > 12 * 60) diff -= 24 * 60;
  if (diff < -12 * 60) diff += 24 * 60;
  return diff;
}

/** The Copenhagen calendar day of an instant, "YYYY-MM-DD". */
export function copenhagenDay(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Copenhagen", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/** Midnight of that Copenhagen day, as an instant. */
export function copenhagenMidnight(d: Date): Date {
  const utc = new Date(`${copenhagenDay(d)}T00:00:00Z`);
  return new Date(utc.getTime() - copenhagenOffsetMinutes(utc) * 60_000);
}

/** `YYYY-MM-DD HH:MM:SS.0000+ZZZZ` in Copenhagen wall-clock time, as Aula's calendar expects. */
export function aulaTs(d: Date): string {
  const off = copenhagenOffsetMinutes(d);
  const local = new Date(d.getTime() + off * 60_000);
  const p = (n: number) => String(n).padStart(2, "0");
  const sign = off >= 0 ? "+" : "-";
  const a = Math.abs(off);
  return `${local.getUTCFullYear()}-${p(local.getUTCMonth() + 1)}-${p(local.getUTCDate())} ${p(local.getUTCHours())}:${p(local.getUTCMinutes())}:${p(local.getUTCSeconds())}.0000${sign}${p(Math.floor(a / 60))}${p(a % 60)}`;
}

/** Windows of 49 days covering a week back to 13 weeks ahead (two calls). */
export function calendarWindows(now: Date, opts: { backDays?: number; aheadDays?: number; size?: number } = {}): { start: string; end: string; from: Date; to: Date }[] {
  const size = opts.size ?? CALENDAR_WINDOW_DAYS;
  const start = copenhagenMidnight(new Date(now.getTime() - (opts.backDays ?? 7) * 86_400_000));
  const stop = copenhagenMidnight(new Date(now.getTime() + (opts.aheadDays ?? 91) * 86_400_000));
  const out: { start: string; end: string; from: Date; to: Date }[] = [];
  for (let from = start; from < stop;) {
    // Step by calendar days in Copenhagen (a DST change makes a day 23 or 25 hours).
    const to = copenhagenMidnight(new Date(from.getTime() + size * 86_400_000 + 12 * 3600_000));
    const end = to > stop ? stop : to;
    out.push({ start: aulaTs(from), end: aulaTs(new Date(end.getTime() - 1000)), from, to: end });
    from = end;
  }
  return out;
}
