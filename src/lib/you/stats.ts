/**
 * The statistics behind "You" (pure, unit-tested). Each finder has a guardrail: a minimum span of data, a minimum
 * effect and a consistency check, so a pattern is only shown when the person's own history really carries it.
 *
 *   seasonality      ≥ 2 years (a single month: ≥ 3); the same months higher (or lower) than that year's typical month
 *                    in EVERY year, and still clearly so without the most extreme year
 *   lagCorrelation   ≥ 12 weeks with both readings; |r| ≥ 0.3 and t above the 5% critical value
 *   contrast         ≥ 6 weeks in each group; Cohen's d ≥ 0.5
 *   anomaly          ≥ 26 weeks of baseline; robust z (median / MAD) ≥ 2.5 and at least 1.5× (or ⅔ less than) usual
 *   drift            ≥ 0.4 a week before; the last 12 weeks at most 40% of that
 *   streak           ≥ 4 weeks in a row up to the last full week
 */
import { monthly, monthOfWeek } from "./series";
import type { Season, Strength } from "./types";

export const GUARD = {
  seasonYears: 2,
  monthYears: 3,
  seasonRatioDown: 0.75,
  seasonRatioUp: 1.33,
  monthRatioDown: 0.6,
  monthRatioUp: 1.6,
  /** A year counts for seasonality when this many of its weeks have readings. */
  yearWeeks: 40,
  corrWeeks: 12,
  corrR: 0.3,
  contrastPerGroup: 6,
  contrastD: 0.5,
  anomalyBaseline: 26,
  anomalyZ: 2.5,
  anomalyRatio: 1.5,
  driftPrior: 0.4,
  driftRatio: 0.4,
  streak: 4,
} as const;

export const SEASON_MONTHS: Record<Season, number[]> = { winter: [11, 0, 1], spring: [2, 3, 4], summer: [5, 6, 7], autumn: [8, 9, 10] };
export const SEASONS: Season[] = ["winter", "spring", "summer", "autumn"];

const mean = (xs: readonly number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
function sd(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}
function median(xs: readonly number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
const geoMean = (xs: readonly number[]) => Math.exp(mean(xs.map((x) => Math.log(Math.max(x, 1e-6)))));

/* ── Seasonality ──────────────────────────────────────────────────────────────────────────────────────── */

export type SeasonHit = {
  /** A season, or a single month. */
  season?: Season;
  month?: number;
  direction: "up" | "down";
  /** The typical ratio to the year's own average (0.6 = 40% lower). */
  ratio: number;
  /** Per year: the ratio found. */
  years: { year: number; ratio: number }[];
  strength: Strength;
};

/**
 * Months (or seasons) that are consistently higher or lower than the person's own typical month, year after year. "Years"
 * are the 12-month stretches counted back from the last complete month (so 3½ years of history give three), each
 * needing all twelve months with readings, `yearWeeks` weeks in all and a non-zero average. Winter is Dec + Jan + Feb
 * within one stretch. A single month needs `monthYears` stretches (twelve months tested at once find more by chance),
 * and "lower" needs the thing to be there most months (a yearly trip being absent in winter is no finding).
 */
export function seasonality(s: { weeks: string[]; values: (number | null)[] }, opts: { minYears?: number } = {}): SeasonHit[] {
  const minYears = opts.minYears ?? GUARD.seasonYears;
  const byMonth = [...monthly(s).values()].sort((a, b) => a.year * 12 + a.month - (b.year * 12 + b.month));
  // Drop a trailing month that has only just started.
  while (byMonth.length && byMonth[byMonth.length - 1].weeks < 3) byMonth.pop();
  const at = new Map(byMonth.map((m) => [m.year * 12 + m.month, m]));
  const full: { year: number; avg: number; months: Map<number, number>; present: number }[] = [];
  if (byMonth.length) {
    const last = byMonth[byMonth.length - 1].year * 12 + byMonth[byMonth.length - 1].month;
    for (let end = last; end - 11 >= byMonth[0].year * 12 + byMonth[0].month; end -= 12) {
      const months = new Map<number, number>();
      let weeks = 0;
      for (let k = end - 11; k <= end; k++) { const m = at.get(k); if (m) { months.set(m.month, m.mean); weeks += m.weeks; } }
      if (months.size !== 12 || weeks < GUARD.yearWeeks) continue;
      // The year's typical month (median; the mean for things most months don't have), so one very full month
      // doesn't make every other month look low.
      const vals = [...months.values()];
      const avg = median(vals) > 0 ? median(vals) : mean(vals);
      if (avg > 0) full.push({ year: Math.floor(end / 12), avg, months, present: [...months.values()].filter((v) => v > 0).length });
    }
  }
  if (full.length < minYears) return [];
  const mostlyThere = full.every((y) => y.present >= 9);

  const hits: SeasonHit[] = [];
  const test = (months: number[], down: number, up: number): Omit<SeasonHit, "season" | "month"> | null => {
    const ratios = full.map((y) => ({ year: y.year, ratio: mean(months.map((m) => y.months.get(m) ?? 0)) / y.avg }));
    const allDown = ratios.every((r) => r.ratio < 1);
    const allUp = ratios.every((r) => r.ratio > 1);
    if (!allDown && !allUp) return null;
    if (allDown && !mostlyThere) return null;
    const g = geoMean(ratios.map((r) => r.ratio));
    if (allDown && g > down) return null;
    if (allUp && g < up) return null;
    // Not carried by one year alone: without its most extreme year it must still lean the same way clearly.
    const rest = [...ratios].sort((a, b) => Math.abs(Math.log(b.ratio)) - Math.abs(Math.log(a.ratio))).slice(1).map((r) => r.ratio);
    const gr = geoMean(rest);
    if (allDown ? gr > 0.85 : gr < 1.18) return null;
    const each = ratios.every((r) => (allUp ? r.ratio >= up : r.ratio <= down));
    // A single month must stand out in every year on its own (twelve months tested at once find more by chance).
    if (months.length === 1 && !each) return null;
    return { direction: allUp ? "up" : "down", ratio: g, years: ratios, strength: strengthOfYears(ratios.length, ratios.map((r) => r.ratio), allUp ? up : down) };
  };
  for (const season of SEASONS) {
    const h = test(SEASON_MONTHS[season], GUARD.seasonRatioDown, GUARD.seasonRatioUp);
    if (h) hits.push({ ...h, season });
  }
  for (let month = 0; month < 12 && full.length >= GUARD.monthYears; month++) {
    const h = test([month], GUARD.monthRatioDown, GUARD.monthRatioUp);
    if (h) hits.push({ ...h, month });
  }
  return bestSeasonHits(hits);
}

/**
 * Keep the clearest: per direction, one season and at most one month (a month inside a season that already says the
 * same thing is only kept when it is much stronger, as "every November" is more useful than "every autumn" then).
 */
function bestSeasonHits(hits: SeasonHit[]): SeasonHit[] {
  const out: SeasonHit[] = [];
  const size = (h: SeasonHit) => Math.abs(Math.log(h.ratio));
  for (const dir of ["up", "down"] as const) {
    const seasons = hits.filter((h) => h.season && h.direction === dir).sort((a, b) => size(b) - size(a));
    const months = hits.filter((h) => h.month !== undefined && h.direction === dir).sort((a, b) => size(b) - size(a));
    const s = seasons[0], m = months[0];
    if (s && m && SEASON_MONTHS[s.season!].includes(m.month!)) out.push(size(m) > size(s) * 2 ? m : s);
    else { if (s) out.push(s); if (m) out.push(m); }
  }
  return out;
}

function strengthOfYears(years: number, ratios: number[], threshold: number): Strength {
  // Every year past the threshold on its own makes it firmer; more years make it firmer still.
  const each = ratios.every((r) => (threshold < 1 ? r <= threshold : r >= threshold));
  if (years >= 4 && each) return "clear";
  if ((years >= 3 && each) || years >= 4) return "fair";
  return "early";
}

/* ── Lagged correlation ───────────────────────────────────────────────────────────────────────────────── */

export type Correlation = { r: number; n: number; t: number; lag: number; ok: boolean; strength: Strength };

/** Two-sided 5% critical t by degrees of freedom (rounded; df ≥ 60 uses 2.0). */
export function tCritical(df: number): number {
  const table: [number, number][] = [[10, 2.228], [12, 2.179], [15, 2.131], [20, 2.086], [25, 2.06], [30, 2.042], [40, 2.021], [60, 2.0]];
  for (const [d, t] of table) if (df <= d) return t;
  return 1.98;
}

/** Pearson r between x[t] and y[t + lag], over weeks where both have a reading. */
export function lagCorrelation(x: readonly (number | null)[], y: readonly (number | null)[], lag = 0, opts: { minN?: number; minR?: number } = {}): Correlation {
  const minN = opts.minN ?? GUARD.corrWeeks;
  const minR = opts.minR ?? GUARD.corrR;
  const a: number[] = [], b: number[] = [];
  for (let i = 0; i + lag < y.length && i < x.length; i++) {
    const xi = x[i], yi = y[i + lag];
    if (xi === null || yi === null || xi === undefined || yi === undefined) continue;
    a.push(xi); b.push(yi);
  }
  const n = a.length;
  const none: Correlation = { r: 0, n, t: 0, lag, ok: false, strength: "early" };
  if (n < 3) return none;
  const ma = mean(a), mb = mean(b);
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; }
  if (saa === 0 || sbb === 0) return none;
  const r = sab / Math.sqrt(saa * sbb);
  const t = Math.abs(r) >= 1 ? Infinity : r * Math.sqrt((n - 2) / (1 - r * r));
  const ok = n >= minN && Math.abs(r) >= minR && Math.abs(t) >= tCritical(n - 2);
  const strength: Strength = Math.abs(r) >= 0.5 && n >= 52 ? "clear" : Math.abs(r) >= 0.4 && n >= 26 ? "fair" : "early";
  return { r, n, t, lag, ok, strength };
}

/* ── Contrast: one kind of week vs the rest ──────────────────────────────────────────────────────────── */

export type Contrast = { d: number; inMean: number; outMean: number; nIn: number; nOut: number; ok: boolean; strength: Strength };

/** Cohen's d of y in weeks where `mask` is true vs the others (weeks where y has no reading are left out). */
export function contrast(y: readonly (number | null)[], mask: readonly boolean[], opts: { minPerGroup?: number; minD?: number } = {}): Contrast {
  const minPer = opts.minPerGroup ?? GUARD.contrastPerGroup;
  const minD = opts.minD ?? GUARD.contrastD;
  const a: number[] = [], b: number[] = [];
  for (let i = 0; i < y.length; i++) {
    const v = y[i];
    if (v === null || v === undefined) continue;
    (mask[i] ? a : b).push(v);
  }
  const pooled = Math.sqrt(((a.length - 1) * sd(a) ** 2 + (b.length - 1) * sd(b) ** 2) / Math.max(1, a.length + b.length - 2));
  const d = pooled > 0 ? (mean(a) - mean(b)) / pooled : 0;
  const ok = a.length >= minPer && b.length >= minPer && Math.abs(d) >= minD;
  const n = a.length + b.length;
  const strength: Strength = Math.abs(d) >= 0.8 && n >= 52 ? "clear" : Math.abs(d) >= 0.5 && n >= 26 ? "fair" : "early";
  return { d, inMean: mean(a), outMean: mean(b), nIn: a.length, nOut: b.length, ok, strength };
}

/* ── Anomaly vs the person's own baseline ─────────────────────────────────────────────────────────────── */

export type Anomaly = { z: number; ratio: number; recent: number; usual: number; baselineWeeks: number; ok: boolean; direction: "up" | "down" };

/**
 * The mean of the last `recent` weeks against the `baseline` weeks before them: robust z (median and MAD, scaled to
 * a normal sd; when MAD is 0 the plain sd is used). Weeks without a reading are skipped.
 */
export function anomaly(values: readonly (number | null)[], opts: { recent?: number; baseline?: number; minBaseline?: number } = {}): Anomaly {
  const recentN = opts.recent ?? 4, baseN = opts.baseline ?? 52, minBase = opts.minBaseline ?? GUARD.anomalyBaseline;
  const recent = values.slice(-recentN).filter((v): v is number => v !== null);
  const base = values.slice(Math.max(0, values.length - recentN - baseN), values.length - recentN).filter((v): v is number => v !== null);
  const none: Anomaly = { z: 0, ratio: 1, recent: mean(recent), usual: median(base), baselineWeeks: base.length, ok: false, direction: "up" };
  if (base.length < minBase || !recent.length) return none;
  const med = median(base);
  const mad = median(base.map((v) => Math.abs(v - med))) * 1.4826;
  const scale = mad > 0 ? mad : sd(base);
  if (scale === 0) return none;
  const r = mean(recent);
  const z = (r - med) / (scale / Math.sqrt(recent.length));
  const usual = Math.max(med, mean(base));
  const ratio = usual > 0 ? r / usual : r > 0 ? Infinity : 1;
  const big = ratio >= GUARD.anomalyRatio || ratio <= 1 / GUARD.anomalyRatio;
  return { z, ratio, recent: r, usual, baselineWeeks: base.length, ok: Math.abs(z) >= GUARD.anomalyZ && big && usual > 0, direction: z >= 0 ? "up" : "down" };
}

/* ── Drift: a relationship (or anything) fading ───────────────────────────────────────────────────────── */

export type Drift = { prior: number; recent: number; ratio: number; ok: boolean };

/** Weekly rate in the last `recent` weeks vs the `prior` weeks before them. */
export function drift(values: readonly (number | null)[], opts: { recent?: number; prior?: number } = {}): Drift {
  const recentN = opts.recent ?? 12, priorN = opts.prior ?? 40;
  const rec = values.slice(-recentN).map((v) => v ?? 0);
  const pri = values.slice(Math.max(0, values.length - recentN - priorN), values.length - recentN).map((v) => v ?? 0);
  const prior = mean(pri), recent = mean(rec);
  const ratio = prior > 0 ? recent / prior : 1;
  return { prior, recent, ratio, ok: pri.length >= priorN * 0.75 && prior >= GUARD.driftPrior && ratio <= GUARD.driftRatio };
}

/* ── Streak ───────────────────────────────────────────────────────────────────────────────────────────── */

/** Weeks in a row, ending at the last value, with something (> 0). */
export function streak(values: readonly (number | null)[]): number {
  let n = 0;
  for (let i = values.length - 1; i >= 0; i--) { if ((values[i] ?? 0) > 0) n++; else break; }
  return n;
}

/** Whole years between the first data and the end (for "over 3 years"). */
export function yearsOfData(weeks: readonly string[], values: readonly (number | null)[]): number {
  const i = values.findIndex((v) => v !== null && v !== 0);
  if (i < 0) return 0;
  return Math.floor((weeks.length - i) / 52);
}

export function seasonOfMonth(month: number): Season {
  return SEASONS.find((s) => SEASON_MONTHS[s].includes(month))!;
}

/** The calendar months (0-11) of a week list, for picking receipts. */
export function monthsOfWeeks(weeks: readonly string[]): number[] {
  return weeks.map((w) => monthOfWeek(w).month);
}
