/**
 * Time-zone aware date helpers for the Today page and briefs. Pure (no server imports) so client components and tests
 * can use them. Built on Intl, so they work the same whatever time zone the server runs in.
 */

/** The household's time zone. Danish family context; override with APP_TIME_ZONE. */
export const DEFAULT_TIME_ZONE = "Europe/Copenhagen";

export function appTimeZone(): string {
  const tz = typeof process !== "undefined" ? process.env.APP_TIME_ZONE : undefined;
  return tz && isValidTimeZone(tz) ? tz : DEFAULT_TIME_ZONE;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export type ZonedParts = { year: number; month: number; day: number; hour: number; minute: number; second: number; weekday: number };

const partsFormatters = new Map<string, Intl.DateTimeFormat>();
const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

/** Wall-clock parts of `date` in `tz`. weekday: Monday = 1 … Sunday = 7. */
export function zonedParts(date: Date, tz: string): ZonedParts {
  let f = partsFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", weekday: "short",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    partsFormatters.set(tz, f);
  }
  const out: Record<string, string> = {};
  for (const p of f.formatToParts(date)) out[p.type] = p.value;
  return {
    year: Number(out.year), month: Number(out.month), day: Number(out.day),
    hour: Number(out.hour) % 24, minute: Number(out.minute), second: Number(out.second),
    weekday: WEEKDAYS[out.weekday] ?? 1,
  };
}

/** Offset of `tz` from UTC at `date`, in milliseconds (Copenhagen: +1h in winter, +2h in summer). */
export function zoneOffsetMs(date: Date, tz: string): number {
  const p = zonedParts(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** The instant at which the wall clock in `tz` shows the given time. Day/month overflow is allowed (day 32 → next month). */
export function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, tz: string, second = 0): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  const off1 = zoneOffsetMs(new Date(guess), tz);
  let t = guess - off1;
  const off2 = zoneOffsetMs(new Date(t), tz);
  if (off2 !== off1) t = guess - off2;
  return new Date(t);
}

/** "YYYY-MM-DD" of `date` in `tz`. */
export function dayKey(date: Date, tz: string): string {
  const p = zonedParts(date, tz);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

function dayNumber(key: string): number {
  const [y, m, d] = key.split("-").map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86_400_000);
}

/** Calendar days from `now`'s day to `date`'s day in `tz` (0 = same day, 1 = tomorrow, -1 = yesterday). */
export function calendarDayDiff(date: Date, now: Date, tz: string): number {
  return dayNumber(dayKey(date, tz)) - dayNumber(dayKey(now, tz));
}

/** Midnight at the start of `date`'s day in `tz`. */
export function startOfDayInZone(date: Date, tz: string): Date {
  const p = zonedParts(date, tz);
  return zonedTimeToUtc(p.year, p.month, p.day, 0, 0, tz);
}

/** Same wall-clock time `days` calendar days later in `tz` (keeps 08:00 at 08:00 across a DST change). */
export function addDaysInZone(date: Date, days: number, tz: string): Date {
  const p = zonedParts(date, tz);
  return zonedTimeToUtc(p.year, p.month, p.day + days, p.hour, p.minute, tz, p.second);
}

/* ── Day buckets ──────────────────────────────────────────────────────────────────────────────────────── */

export type Bucket = "overdue" | "today" | "tomorrow" | "week" | "later";

export const BUCKET_ORDER: Bucket[] = ["overdue", "today", "tomorrow", "week", "later"];

export const BUCKET_LABEL: Record<Bucket, string> = {
  overdue: "Overdue",
  today: "Today",
  tomorrow: "Tomorrow",
  week: "This week",
  later: "Later",
};

/**
 * Which list a date belongs in, seen from `now` in `tz`.
 * "This week" is the rest of the current Monday–Sunday week after tomorrow (Danish weeks start on Monday);
 * anything after Sunday is "Later". Anything before today is "Overdue".
 */
export function bucketFor(date: Date, now: Date, tz: string): Bucket {
  const diff = calendarDayDiff(date, now, tz);
  if (diff < 0) return "overdue";
  if (diff === 0) return "today";
  if (diff === 1) return "tomorrow";
  const daysLeftInWeek = 7 - zonedParts(now, tz).weekday; // Sunday → 0
  return diff <= daysLeftInWeek ? "week" : "later";
}

export type BucketGroup<T> = { bucket: Bucket; label: string; items: T[] };

/** Group items into day buckets (in display order, empty buckets dropped), each sorted by date ascending. */
export function groupByBucket<T>(items: T[], getDate: (item: T) => Date, now: Date, tz: string): BucketGroup<T>[] {
  const map = new Map<Bucket, T[]>();
  for (const item of items) {
    const b = bucketFor(getDate(item), now, tz);
    const list = map.get(b) ?? [];
    list.push(item);
    map.set(b, list);
  }
  return BUCKET_ORDER.filter((b) => map.has(b)).map((b) => ({
    bucket: b,
    label: BUCKET_LABEL[b],
    items: map.get(b)!.slice().sort((x, y) => getDate(x).getTime() - getDate(y).getTime()),
  }));
}

/* ── Ages ─────────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * The age someone reaches this calendar year. We only store birth year (never a CPR number or full birthday), so this
 * is "turns N this year" — the person is N or N−1 today. Null when unknown or implausible.
 */
export function ageThisYear(birthYear: number | null | undefined, now: Date, tz: string): number | null {
  if (birthYear == null || !Number.isInteger(birthYear)) return null;
  const age = zonedParts(now, tz).year - birthYear;
  return age < 0 || age > 130 ? null : age;
}

export function ageLabel(age: number | null): string | null {
  if (age === null) return null;
  if (age === 0) return "Born this year";
  return `${age} this year`;
}

/* ── Formatting ───────────────────────────────────────────────────────────────────────────────────────── */

const LOCALE = "en-GB";

export function formatTime(date: Date, tz: string): string {
  return new Intl.DateTimeFormat(LOCALE, { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
}

/** "Wed 5 Nov" */
export function formatShortDay(date: Date, tz: string): string {
  return new Intl.DateTimeFormat(LOCALE, { timeZone: tz, weekday: "short", day: "numeric", month: "short" }).format(date);
}

/** "Tuesday, 3 November 2026" */
export function formatLongDate(date: Date, tz: string): string {
  return new Intl.DateTimeFormat(LOCALE, { timeZone: tz, weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(date);
}

/** "Today 14:30", "Tomorrow", "Wed 5 Nov 08:00" — `withTime` false for all-day items. */
export function formatWhen(date: Date, now: Date, tz: string, withTime = true): string {
  const diff = calendarDayDiff(date, now, tz);
  const day = diff === 0 ? "Today" : diff === 1 ? "Tomorrow" : diff === -1 ? "Yesterday" : formatShortDay(date, tz);
  return withTime ? `${day} ${formatTime(date, tz)}` : day;
}

/** Whether an event's time of day is meaningful (minute precision, or unknown precision and not midnight). */
export function hasTimeOfDay(date: Date, precision: string | null | undefined, tz: string): boolean {
  if (precision === "minute") return true;
  if (precision) return false;
  const p = zonedParts(date, tz);
  return p.hour !== 0 || p.minute !== 0;
}

export function greetingFor(now: Date, tz: string): string {
  const h = zonedParts(now, tz).hour;
  if (h < 5) return "Good evening";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

/** Value for <input type="datetime-local"> in the browser's own time zone. */
export function toLocalInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Parse an <input type="datetime-local"> value (browser time zone). Null when empty or invalid. */
export function fromLocalInputValue(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}
