/**
 * Weekly time series (pure). Weeks start on Monday in the person's own time zone and are named by that Monday's date
 * (YYYY-MM-DD). A week belongs to the month its Thursday falls in (as ISO weeks do), so a year has 52 or 53 of them.
 */
import type { Agg, Point, Ref, Series } from "./types";

const DAY = 86_400_000;

/** The calendar day (YYYY-MM-DD) of an instant in a time zone. */
export function localDay(at: Date | string, tz: string): string {
  const d = typeof at === "string" ? new Date(at) : at;
  try {
    const p = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
    const get = (t: string) => p.find((x) => x.type === t)?.value ?? "";
    return `${get("year")}-${get("month")}-${get("day")}`;
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

/** The local hour (0-23) and weekday (0 = Sunday) of an instant. */
export function localClock(at: Date | string, tz: string): { hour: number; weekday: number } {
  const d = typeof at === "string" ? new Date(at) : at;
  try {
    const p = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hourCycle: "h23", weekday: "short" }).formatToParts(d);
    const hour = Number(p.find((x) => x.type === "hour")?.value ?? d.getUTCHours());
    const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.find((x) => x.type === "weekday")?.value ?? "");
    return { hour: hour === 24 ? 0 : hour, weekday: wd < 0 ? d.getUTCDay() : wd };
  } catch {
    return { hour: d.getUTCHours(), weekday: d.getUTCDay() };
  }
}

const dayMs = (day: string) => Date.parse(`${day}T00:00:00Z`);
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The Monday of a calendar day. */
export function mondayOf(day: string): string {
  const ms = dayMs(day);
  const wd = new Date(ms).getUTCDay(); // 0 Sunday
  return dayOf(ms - ((wd + 6) % 7) * DAY);
}

export function weekOf(at: Date | string, tz: string): string {
  return mondayOf(localDay(at, tz));
}

export function addWeeks(week: string, n: number): string {
  return dayOf(dayMs(week) + n * 7 * DAY);
}

/** Every Monday from the week of `from` to the week of `to`, inclusive. */
export function weeksBetween(fromWeek: string, toWeek: string): string[] {
  const out: string[] = [];
  for (let ms = dayMs(fromWeek), end = dayMs(toWeek); ms <= end && out.length < 2000; ms += 7 * DAY) out.push(dayOf(ms));
  return out;
}

/** The month (0-11) and year a week belongs to: its Thursday's. */
export function monthOfWeek(week: string): { year: number; month: number } {
  const d = new Date(dayMs(week) + 3 * DAY);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() };
}

/**
 * Points → one value per week from `fromWeek` to `toWeek`.
 *   sum:  the sum of values (1 each when no value) — empty weeks are 0;
 *   days: how many distinct days had a point — empty weeks are 0;
 *   mean: the mean of values — empty weeks are null (no reading, not zero).
 */
export function weekly(key: string, points: readonly Point[], opts: { fromWeek: string; toWeek: string; tz: string; agg?: Agg }): Series {
  const agg = opts.agg ?? "sum";
  const weeks = weeksBetween(opts.fromWeek, opts.toWeek);
  const index = new Map(weeks.map((w, i) => [w, i]));
  const sums = new Array<number>(weeks.length).fill(0);
  const counts = new Array<number>(weeks.length).fill(0);
  const days = weeks.map(() => new Set<string>());
  let first: string | null = null;
  for (const p of points) {
    const day = localDay(p.at, opts.tz);
    const w = mondayOf(day);
    const i = index.get(w);
    if (i === undefined) continue;
    const v = typeof p.value === "number" && Number.isFinite(p.value) ? p.value : 1;
    sums[i] += v;
    counts[i] += 1;
    days[i].add(day);
    if (!first || w < first) first = w;
  }
  const values: (number | null)[] = weeks.map((_, i) => agg === "mean" ? (counts[i] ? sums[i] / counts[i] : null) : agg === "days" ? days[i].size : sums[i]);
  const total = agg === "mean" ? counts.reduce((a, b) => a + b, 0) : values.reduce<number>((a, b) => a + (b ?? 0), 0);
  return { key, weeks, values, total, first };
}

/** Days covered by a range (a trip from Friday to Sunday is three days), as points, one per local day. */
export function spanDays(from: Date | string, to: Date | string | null, tz: string, ref?: Ref | null, maxDays = 60): { at: string; ref?: Ref | null }[] {
  const a = localDay(from, tz);
  const b = to ? localDay(to, tz) : a;
  const out: { at: string; ref?: Ref | null }[] = [];
  for (let ms = dayMs(a), end = Math.max(dayMs(a), dayMs(b)); ms <= end && out.length < maxDays; ms += DAY) out.push({ at: `${dayOf(ms)}T12:00:00Z`, ref });
  return out;
}

/** The first week with any data (non-null, non-zero), or null. */
export function firstDataIndex(values: readonly (number | null)[]): number {
  return values.findIndex((v) => v !== null && v !== 0);
}

/** Per (year, month): the mean weekly value and how many weeks had a reading. Weeks before the data starts are skipped. */
export function monthly(s: Pick<Series, "weeks" | "values">): Map<string, { year: number; month: number; mean: number; weeks: number }> {
  const start = firstDataIndex(s.values);
  const acc = new Map<string, { year: number; month: number; sum: number; weeks: number }>();
  if (start < 0) return new Map();
  for (let i = start; i < s.weeks.length; i++) {
    const v = s.values[i];
    if (v === null) continue;
    const { year, month } = monthOfWeek(s.weeks[i]);
    const k = `${year}-${month}`;
    const cur = acc.get(k) ?? { year, month, sum: 0, weeks: 0 };
    cur.sum += v;
    cur.weeks += 1;
    acc.set(k, cur);
  }
  return new Map([...acc].map(([k, x]) => [k, { year: x.year, month: x.month, mean: x.sum / x.weeks, weeks: x.weeks }]));
}

/** Twelve monthly means across all years (null when a month has no reading). */
export function monthProfile(s: Pick<Series, "weeks" | "values">): (number | null)[] {
  const sums = new Array<number>(12).fill(0);
  const n = new Array<number>(12).fill(0);
  for (const m of monthly(s).values()) { sums[m.month] += m.mean; n[m.month] += 1; }
  return sums.map((x, i) => (n[i] ? x / n[i] : null));
}

/** The last `n` values, summed in pairs when `pair` (a two-year sparkline in 52 marks). */
export function tail(values: readonly (number | null)[], n: number, pair = false): (number | null)[] {
  const t = values.slice(Math.max(0, values.length - n));
  if (!pair) return [...t];
  const out: (number | null)[] = [];
  for (let i = 0; i < t.length; i += 2) {
    const a = t[i], b = t[i + 1];
    out.push(a === null && (b === null || b === undefined) ? null : (a ?? 0) + (b ?? 0));
  }
  return out;
}
