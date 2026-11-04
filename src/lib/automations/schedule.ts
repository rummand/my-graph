/**
 * Schedule maths (pure, tested). Times are wall-clock times in the automation's timezone (default Europe/Copenhagen);
 * everything stored is UTC. Daylight saving is handled by converting each local time through Intl, so "Sundays 18:00"
 * stays 18:00 local all year. A local time that does not exist (02:30 on the spring-forward night) runs at the first
 * valid minute after the gap; a local time that happens twice (the autumn night) runs the first time.
 */
import { z } from "zod";

export const DEFAULT_TZ = "Europe/Copenhagen";
export const HEARTBEAT_INTERVALS = [15, 30, 60, 120] as const;
export const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
export const WEEKDAYS = [1, 2, 3, 4, 5];

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a time like 07:30.");
const days = z.array(z.number().int().min(0).max(6)).min(1, "Pick at least one day.").max(7)
  .transform((d) => [...new Set(d)].sort((a, b) => a - b));
const tz = z.string().min(1).max(64).refine(isValidTimeZone, "Unknown timezone.").default(DEFAULT_TZ);

export const scheduleConfig = z.object({
  days: days.default(ALL_DAYS),
  time: hhmm,
  /** One-shot on a specific local date (YYYY-MM-DD) instead of weekdays. */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish().transform((v) => v ?? null),
  tz,
});
export const heartbeatConfig = z.object({
  everyMinutes: z.number().int().refine((n) => (HEARTBEAT_INTERVALS as readonly number[]).includes(n), "Pick 15, 30, 60 or 120 minutes.").default(60),
  days: days.default(WEEKDAYS),
  from: hhmm.default("07:00"),
  to: hhmm.default("20:00"),
  tz,
}).refine((c) => toMinutes(c.from) < toMinutes(c.to), { message: "The end of the check-in hours must be after the start.", path: ["to"] });
export const conditionConfig = z.object({
  check: z.string().trim().min(3, "Say what to look for.").max(300),
  everyMinutes: z.number().int().min(15).max(24 * 60).default(60),
  tz,
});

export type ScheduleConfig = z.infer<typeof scheduleConfig>;
export type HeartbeatConfig = z.infer<typeof heartbeatConfig>;
export type ConditionConfig = z.infer<typeof conditionConfig>;
export type TriggerKind = "schedule" | "condition" | "heartbeat";

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function toMinutes(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

export type LocalParts = { year: number; month: number; day: number; hour: number; minute: number; weekday: number };

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short",
    });
    fmtCache.set(tz, f);
  }
  return f;
}
const WD: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Wall-clock parts of an instant in a timezone. */
export function localParts(d: Date, tz: string): LocalParts {
  const p: Record<string, string> = {};
  for (const x of fmt(tz).formatToParts(d)) p[x.type] = x.value;
  return { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour % 24, minute: +p.minute, weekday: WD[p.weekday] ?? 0 };
}

/** Offset (local − UTC) in minutes at an instant. */
function offsetAt(d: Date, tz: string): number {
  const p = localParts(d, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return Math.round((asUtc - Math.floor(d.getTime() / 60000) * 60000) / 60000);
}

/**
 * The UTC instant of a local wall-clock time. Non-existent times (DST gap) move forward past the gap;
 * ambiguous times (DST overlap) resolve to the earlier instant.
 */
export function zonedTime(year: number, month: number, day: number, hour: number, minute: number, tz: string): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const offsets = [-12, 0, 12].map((h) => offsetAt(new Date(guess + h * 3600_000), tz));
  // Earlier candidate first (the larger offset gives the earlier instant).
  const cands = [...new Set(offsets)].sort((a, b) => b - a).map((o) => new Date(guess - o * 60000));
  for (const c of cands) {
    const p = localParts(c, tz);
    if (p.year === year && p.month === month && p.day === day && p.hour === hour && p.minute === minute) return c;
  }
  // In the gap: the wall time never happens. Use the same wall time with the offset from before the gap,
  // which lands after the jump (02:30 → 03:30 in Copenhagen).
  const before = offsetAt(new Date(guess - 6 * 3600_000), tz);
  return new Date(guess - before * 60000);
}

/** The local calendar date `n` days after (y, m, d). */
function addDays(y: number, m: number, d: number, n: number) {
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate(), weekday: t.getUTCDay() };
}

/** Next run of a schedule strictly after `after`, or null (a one-shot date in the past). */
export function nextScheduleRun(c: ScheduleConfig, after: Date): Date | null {
  const [h, m] = c.time.split(":").map(Number);
  if (c.date) {
    const [y, mo, d] = c.date.split("-").map(Number);
    const at = zonedTime(y, mo, d, h, m, c.tz);
    return at > after ? at : null;
  }
  const start = localParts(after, c.tz);
  for (let i = 0; i <= 8; i++) {
    const day = addDays(start.year, start.month, start.day, i);
    if (!c.days.includes(day.weekday)) continue;
    const at = zonedTime(day.year, day.month, day.day, h, m, c.tz);
    if (at > after) return at;
  }
  return null;
}

/** Whether an instant falls inside the heartbeat's days and hours (from inclusive, to inclusive). */
export function inHeartbeatWindow(c: HeartbeatConfig, at: Date): boolean {
  const p = localParts(at, c.tz);
  if (!c.days.includes(p.weekday)) return false;
  const mins = p.hour * 60 + p.minute;
  return mins >= toMinutes(c.from) && mins <= toMinutes(c.to);
}

/** Next heartbeat check-in after `after`: every N minutes, only inside its days and hours. */
export function nextHeartbeatRun(c: HeartbeatConfig, after: Date): Date | null {
  const step = Math.floor(after.getTime() / 60000) * 60000 + c.everyMinutes * 60000;
  const candidate = new Date(step);
  if (inHeartbeatWindow(c, candidate)) return candidate;
  // Otherwise: the next window opening after `after`.
  const [fh, fm] = c.from.split(":").map(Number);
  const start = localParts(after, c.tz);
  for (let i = 0; i <= 8; i++) {
    const day = addDays(start.year, start.month, start.day, i);
    if (!c.days.includes(day.weekday)) continue;
    const open = zonedTime(day.year, day.month, day.day, fh, fm, c.tz);
    if (open > after) return open;
  }
  return null;
}

export function nextConditionRun(c: ConditionConfig, after: Date): Date {
  return new Date(Math.floor(after.getTime() / 60000) * 60000 + c.everyMinutes * 60000);
}

export type ParsedTrigger =
  | { trigger: "schedule"; config: ScheduleConfig }
  | { trigger: "heartbeat"; config: HeartbeatConfig }
  | { trigger: "condition"; config: ConditionConfig };

/** Validate a stored or submitted config for its trigger. Throws a ZodError on bad input. */
export function parseTrigger(trigger: TriggerKind, config: unknown): ParsedTrigger {
  if (trigger === "schedule") return { trigger, config: scheduleConfig.parse(config) };
  if (trigger === "heartbeat") return { trigger, config: heartbeatConfig.parse(config) };
  return { trigger, config: conditionConfig.parse(config) };
}

export function safeParseTrigger(trigger: TriggerKind, config: unknown): ParsedTrigger | null {
  try {
    return parseTrigger(trigger, config);
  } catch {
    return null;
  }
}

/** When this automation should run next, after `after`. Null = never again. */
export function nextRun(t: ParsedTrigger, after: Date): Date | null {
  if (t.trigger === "schedule") return nextScheduleRun(t.config, after);
  if (t.trigger === "heartbeat") return nextHeartbeatRun(t.config, after);
  return nextConditionRun(t.config, after);
}

/** The next `n` run times (the "preview" under the New automation form). */
export function previewRuns(t: ParsedTrigger, from: Date, n = 3): Date[] {
  const out: Date[] = [];
  let at: Date | null = from;
  while (out.length < n && at) {
    at = nextRun(t, at);
    if (at) out.push(at);
    if (t.trigger === "schedule" && t.config.date) break;
  }
  return out;
}

/* ── Claiming (pure parts) ───────────────────────────────────────────────────────────────────────────── */

/** While a run is in progress its next_run_at is pushed out by this lease, so a crashed run is retried later. */
export const CLAIM_LEASE_MS = 15 * 60 * 1000;
export const TICK_MS = 60 * 1000;
export const CLAIM_BATCH = 5;

export function isDue(a: { enabled: boolean; nextRunAt: Date | null }, now: Date): boolean {
  return a.enabled && !!a.nextRunAt && a.nextRunAt.getTime() <= now.getTime();
}

export function leaseUntil(now: Date): Date {
  return new Date(now.getTime() + CLAIM_LEASE_MS);
}

/** After a run: when to run next, and whether the automation stays on. One-shots switch off after a successful run. */
export function afterRun(a: { oneShot: boolean }, t: ParsedTrigger | null, status: "done" | "failed" | "skipped", now: Date): { enabled: boolean; nextRunAt: Date | null } {
  if (!t) return { enabled: false, nextRunAt: null };
  if (a.oneShot && status === "done") return { enabled: false, nextRunAt: null };
  const next = nextRun(t, now);
  return { enabled: next !== null, nextRunAt: next };
}

/** Plain-English description of a trigger ("Sundays at 18:00", "Every 30 minutes, weekdays 07:00–20:00"). */
export function describeTrigger(t: ParsedTrigger): string {
  if (t.trigger === "schedule") {
    if (t.config.date) return `Once, on ${t.config.date} at ${t.config.time}`;
    return `${describeDays(t.config.days, true)} at ${t.config.time}`;
  }
  if (t.trigger === "heartbeat") {
    return `${everyLabel(t.config.everyMinutes)}, ${describeDays(t.config.days, false).toLowerCase()} ${t.config.from}–${t.config.to}`;
  }
  return `${everyLabel(t.config.everyMinutes)}, when ${lowerFirst(t.config.check)}`;
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function describeDays(d: number[], plural: boolean): string {
  const s = [...d].sort();
  if (s.length === 7) return "Every day";
  if (s.join() === WEEKDAYS.join()) return "Weekdays";
  if (s.join() === "0,6") return "Weekends";
  const names = s.map((x) => (plural ? `${DAY_NAMES[x]}s` : DAY_NAMES[x]));
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function everyLabel(m: number): string {
  if (m % 60 === 0) return m === 60 ? "Every hour" : `Every ${m / 60} hours`;
  return `Every ${m} minutes`;
}
function lowerFirst(s: string) {
  return s ? s[0].toLowerCase() + s.slice(1) : s;
}
