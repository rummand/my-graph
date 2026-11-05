/**
 * From weekly signals to findings (pure). Every finder in ./stats has its guardrail; this file decides which signals
 * are compared, builds the receipts and the small chart, and ranks with the person's own feedback: "Not really" makes
 * the same kind of finding need a firmer pattern next time, "Yes" lifts it.
 */
import { addWeeks, monthOfWeek, monthProfile, tail } from "./series";
import { anomaly, contrast, drift, GUARD, lagCorrelation, SEASON_MONTHS, seasonality, streak, yearsOfData, type SeasonHit } from "./stats";
import type { Feedback, Finding, InsightKind, Ref, Series, SignalKey, Strength } from "./types";

export type PersonSeries = { id: string; name: string; series: Series; refs: Map<string, Ref[]> };

export type SignalSet = {
  series: Partial<Record<SignalKey, Series>>;
  refs: Partial<Record<SignalKey, Map<string, Ref[]>>>;
  people: PersonSeries[];
  graphKind: string;
};

/** Minimum total before a count signal is looked at all (mood counts readings). */
const MIN_TOTAL = 20;

/** Which pairs are compared, and with which lags (weeks). Mood is always the outcome when it is in a pair. */
export const PAIRS: { x: SignalKey; y: SignalKey; lags: number[] }[] = [
  { x: "outdoors", y: "mood", lags: [0, 1] },
  { x: "meetings", y: "mood", lags: [0, 1] },
  { x: "evenings", y: "mood", lags: [0, 1] },
  { x: "commitments", y: "mood", lags: [1] },
  { x: "overdue", y: "mood", lags: [0] },
  { x: "meetings", y: "contact", lags: [0] },
  { x: "away", y: "contact", lags: [0] },
  { x: "workload", y: "contact", lags: [0] },
];

const KIND_WEIGHT: Record<InsightKind, number> = { season: 3, contrast: 3, drift: 2.5, correlation: 2, anomaly: 2, streak: 1 };
const STRENGTH_WEIGHT: Record<Strength, number> = { early: 0.6, fair: 0.8, clear: 1 };

/** Mood is -1 … 1; seasonality needs positive values, so it is read as 0 … 2. */
const forSeason = (key: SignalKey, values: (number | null)[]) => (key === "mood" ? values.map((v) => (v === null ? null : v + 1)) : values);

function usable(key: SignalKey, s: Series | undefined): s is Series {
  if (!s || !s.first) return false;
  return key === "mood" ? s.total >= 12 : s.total >= MIN_TOTAL;
}

function refsIn(refs: Map<string, Ref[]> | undefined, weeks: string[], max = 5): Ref[] {
  if (!refs) return [];
  const out: Ref[] = [];
  const seen = new Set<string>();
  for (const w of [...weeks].sort().reverse()) {
    for (const r of refs.get(w) ?? []) {
      if (seen.has(r.href)) continue;
      seen.add(r.href);
      out.push(r);
      if (out.length >= max) return out;
    }
  }
  return out;
}

function seasonFinding(signal: SignalKey, s: Series, h: SeasonHit, refs: Map<string, Ref[]> | undefined, person?: { id: string; name: string }): Finding {
  const months = h.season ? SEASON_MONTHS[h.season] : [h.month!];
  const inside = s.weeks.map((w, i) => ({ w, v: s.values[i], m: monthOfWeek(w).month })).filter((x) => months.includes(x.m) && x.v !== null);
  // Up: the fullest weeks of the pattern; down: the most recent ones (where it is quiet).
  const picked = h.direction === "up" ? [...inside].filter((x) => (x.v as number) > 0).sort((a, b) => (b.v as number) - (a.v as number)).slice(0, 10).sort((a, b) => a.w.localeCompare(b.w)) : inside.slice(-10);
  const weeks = picked.map((x) => ({ week: x.w, value: round(x.v as number) }));
  const where = h.season ?? `m${h.month}`;
  const years = h.years.length;
  return {
    key: `season:${signal}${person ? `:${person.id}` : ""}:${where}:${h.direction}`,
    kind: "season", signal, person: person ?? null, direction: h.direction, season: h.season, month: h.month,
    effect: h.ratio, span: { years }, n: years, strength: h.strength,
    chart: { type: "ring", months: monthProfile({ weeks: s.weeks, values: forSeason(signal, s.values) }).map((v) => (v === null ? null : round(v))), highlight: months },
    receipts: {
      counts: [{ key: "years", n: years }, { key: "weeks", n: s.weeks.length - Math.max(0, s.weeks.indexOf(s.first ?? "")) }, { key: signal === "mood" ? "readings" : "things", n: Math.round(s.total) }],
      weeks, links: refsIn(refs, inside.map((x) => x.w)),
    },
    score: 0,
  };
}

/** Values from the first week both series have data. */
function aligned(a: Series, b: Series): { from: number } {
  const ia = Math.max(0, a.weeks.indexOf(a.first ?? a.weeks[0]));
  const ib = Math.max(0, b.weeks.indexOf(b.first ?? b.weeks[0]));
  return { from: Math.max(ia, ib) };
}

export function findPatterns(set: SignalSet, feedback: ReadonlyMap<string, Feedback> = new Map()): Finding[] {
  const out: Finding[] = [];
  const S = set.series;

  // 1. Seasons: the person's own year, signal by signal, and contact with the people they're most in touch with.
  for (const [key, s] of Object.entries(S) as [SignalKey, Series][]) {
    if (!usable(key, s)) continue;
    // Counts need at least about one a month for a month-by-month comparison to mean anything.
    if (key !== "mood" && s.total / Math.max(1, yearsOfData(s.weeks, s.values)) < 12) continue;
    for (const h of seasonality({ weeks: s.weeks, values: forSeason(key, s.values) })) out.push(seasonFinding(key, s, h, set.refs[key]));
  }
  for (const p of set.people) {
    if (p.series.total < 30) continue;
    for (const h of seasonality(p.series)) out.push(seasonFinding("contact", p.series, h, p.refs, { id: p.id, name: p.name }));
  }

  // "You say yes to more than you can manage in November" says what "you say yes to more in November" says, and more.
  const monthsOf = (f: Finding) => (f.season ? SEASON_MONTHS[f.season] : f.month !== undefined ? [f.month] : []);
  const overload = out.filter((f) => f.kind === "season" && f.signal === "overdue" && f.direction === "up");
  for (let i = out.length - 1; i >= 0; i--) {
    const f = out[i];
    if (f.kind === "season" && f.signal === "commitments" && f.direction === "up" && overload.some((o) => monthsOf(o).some((m) => monthsOf(f).includes(m)))) out.splice(i, 1);
  }

  // 2. Things that go together (with a lag of a week, where it makes sense). Correlation, never cause.
  for (const pair of PAIRS) {
    const x = S[pair.x], y = S[pair.y];
    if (!usable(pair.x, x) || !usable(pair.y, y)) continue;
    const { from } = aligned(x, y);
    const xs = x.values.slice(from), ys = y.values.slice(from);
    const best = pair.lags.map((lag) => lagCorrelation(xs, ys, lag)).filter((c) => c.ok).sort((a, b) => Math.abs(b.r) - Math.abs(a.r))[0];
    if (!best) continue;
    const top = x.weeks.slice(from).map((w, i) => ({ w, v: xs[i] ?? 0 })).sort((a, b) => b.v - a.v).slice(0, 8);
    out.push({
      key: `corr:${pair.x}:${pair.y}:${best.lag}`, kind: "correlation", signal: pair.y, other: pair.x,
      direction: best.r > 0 ? "up" : "down", lag: best.lag, effect: best.r, span: { weeks: best.n }, n: best.n, strength: best.strength,
      chart: { type: "pair", a: tail(xs, 52).map(roundN), b: tail(ys, 52).map(roundN), from: x.weeks[Math.max(from, x.weeks.length - 52)] },
      receipts: { counts: [{ key: "weeksBoth", n: best.n }], weeks: top.map((t) => ({ week: t.w, value: round(t.v) })), links: refsIn(set.refs[pair.x], top.map((t) => t.w)) },
      score: 0,
    });
  }

  // 3. The headline contrast: weeks with time outdoors and few meetings vs the rest, by the person's own words.
  const mood = S.mood, outdoors = S.outdoors, meetings = S.meetings;
  if (usable("mood", mood) && outdoors && meetings && outdoors.total >= MIN_TOTAL && meetings.total >= MIN_TOTAL) {
    const from = Math.max(aligned(mood, outdoors).from, aligned(mood, meetings).from);
    const m = meetings.values.slice(from).map((v) => v ?? 0);
    const med = [...m].sort((a, b) => a - b)[m.length >> 1] ?? 0;
    const mask = outdoors.values.slice(from).map((v, i) => (v ?? 0) >= 1 && m[i] <= med);
    const c = contrast(mood.values.slice(from), mask);
    if (c.ok && c.d > 0) {
      const weeks = mood.weeks.slice(from).map((w, i) => ({ w, v: mood.values[from + i], in: mask[i] })).filter((x) => x.in && x.v !== null).slice(-8);
      out.push({
        key: "contrast:mood:outdoors_fewmeetings", kind: "contrast", signal: "mood", other: "outdoors", third: "meetings", direction: "up",
        effect: c.d, span: { weeks: c.nIn + c.nOut }, n: c.nIn + c.nOut, strength: c.strength,
        chart: { type: "bars", a: round(c.inMean + 1), b: round(c.outMean + 1) },
        receipts: { counts: [{ key: "weeksLike", n: c.nIn }, { key: "weeksOther", n: c.nOut }], weeks: weeks.map((x) => ({ week: x.w, value: round(x.v as number) })), links: refsIn(set.refs.mood, weeks.map((x) => x.w)) },
        score: 0,
      });
    }
  }

  // 4. Unusual lately, against the person's own last year.
  for (const key of ["meetings", "evenings", "overdue", "contact", "outdoors", "mood", "workload"] as SignalKey[]) {
    const s = S[key];
    if (!usable(key, s)) continue;
    const start = Math.max(0, s.weeks.indexOf(s.first ?? s.weeks[0]));
    const a = anomaly(s.values.slice(start));
    if (!a.ok) continue;
    const last = s.weeks.slice(-4);
    out.push({
      key: `anomaly:${key}:${a.direction}`, kind: "anomaly", signal: key, direction: a.direction, effect: key === "mood" ? a.recent - a.usual : a.ratio,
      span: { weeks: a.baselineWeeks }, n: a.baselineWeeks, strength: Math.abs(a.z) >= 4 ? "clear" : "fair",
      chart: { type: "spark", values: tail(s.values, 26).map(roundN), from: s.weeks[Math.max(0, s.weeks.length - 26)], highlight: [22, 23, 24, 25] },
      receipts: { counts: [{ key: "baseline", n: a.baselineWeeks }], weeks: last.map((w) => ({ week: w, value: round(s.values[s.weeks.indexOf(w)] ?? 0) })), links: refsIn(set.refs[key], last) },
      score: 0,
    });
  }

  // 5. People fading: much less contact in the last 12 weeks than the 40 before.
  const recentMonths = new Set(set.people[0] ? set.people[0].series.weeks.slice(-12).map((w) => monthOfWeek(w).month) : []);
  for (const p of set.people) {
    const d = drift(p.series.values);
    if (!d.ok) continue;
    // A dip the person's own seasons already explain ("drops every autumn") isn't news.
    const seasonal = out.some((f) => f.kind === "season" && f.person?.id === p.id && f.direction === "down"
      && (f.season ? SEASON_MONTHS[f.season] : [f.month! - 1, f.month!, f.month! + 1].map((m) => (m + 12) % 12)).some((m) => recentMonths.has(m)));
    if (seasonal) continue;
    const vals = p.series.values;
    out.push({
      key: `drift:contact:${p.id}`, kind: "drift", signal: "contact", person: { id: p.id, name: p.name }, direction: "down", effect: d.ratio,
      span: { weeks: 52 }, n: 52, strength: d.ratio <= 0.15 ? "clear" : "fair",
      chart: { type: "spark", values: tail(vals, 52, true).map(roundN), from: p.series.weeks[Math.max(0, p.series.weeks.length - 52)] },
      receipts: {
        counts: [{ key: "before", n: Math.round(d.prior * 40) }, { key: "lately", n: Math.round(d.recent * 12) }],
        weeks: [], links: refsIn(p.refs, p.series.weeks.slice(-52), 4),
      },
      score: 0,
    });
  }

  // 6. Good runs worth noticing.
  for (const key of ["outdoors", "reading"] as SignalKey[]) {
    const s = S[key];
    if (!s) continue;
    const n = streak(s.values);
    if (n < GUARD.streak) continue;
    out.push({
      key: `streak:${key}`, kind: "streak", signal: key, direction: "up", effect: n, span: { weeks: n }, n, strength: n >= 12 ? "clear" : n >= 8 ? "fair" : "early",
      chart: { type: "spark", values: tail(s.values, 16).map(roundN), from: s.weeks[Math.max(0, s.weeks.length - 16)], highlight: Array.from({ length: Math.min(n, 16) }, (_, i) => 15 - i) },
      receipts: { counts: [{ key: "weeksRow", n }], weeks: s.weeks.slice(-Math.min(n, 8)).map((w) => ({ week: w, value: round(s.values[s.weeks.indexOf(w)] ?? 0) })), links: refsIn(set.refs[key], s.weeks.slice(-n)) },
      score: 0,
    });
  }

  return rank(out, feedback);
}

/** Order by how much a finding is worth showing; feedback tunes it. "No" on an early pattern drops it. */
export function rank(findings: Finding[], feedback: ReadonlyMap<string, Feedback>, max = 12): Finding[] {
  // Feedback on one finding also nudges others of the same kind and signal ("not really" about autumn contact makes
  // other season-of-contact findings need to be firmer).
  const family = (f: Pick<Finding, "kind" | "signal">) => `${f.kind}:${f.signal}`;
  const famNo = new Map<string, number>(), famYes = new Map<string, number>();
  for (const [key, fb] of feedback) {
    const parts = key.split(":");
    const fam = parts[0] === "corr" ? `correlation:${parts[2]}` : `${parts[0]}:${parts[1] ?? ""}`;
    if (fb === "no") famNo.set(fam, (famNo.get(fam) ?? 0) + 1);
    if (fb === "yes") famYes.set(fam, (famYes.get(fam) ?? 0) + 1);
  }
  const scored = findings.flatMap((f) => {
    const own = feedback.get(f.key) ?? null;
    const no = (famNo.get(family(f)) ?? 0) + (own === "no" ? 2 : 0);
    if (no > 0 && f.strength === "early") return [];
    if (own === "no" && f.strength !== "clear") return [];
    const size = f.kind === "correlation" ? Math.abs(f.effect) * 2 : f.kind === "contrast" ? Math.abs(f.effect) : f.kind === "streak" ? Math.min(1, f.effect / 12) : f.kind === "anomaly" ? Math.min(2, Math.abs(Math.log(Math.max(1e-3, Math.abs(f.effect))))) + 0.5 : Math.min(2, Math.abs(Math.log(Math.max(1e-3, f.effect))) * 2);
    const tune = (own === "yes" ? 1.3 : 1) * ((famYes.get(family(f)) ?? 0) > 0 ? 1.1 : 1) * Math.pow(0.6, no);
    return [{ ...f, score: round(KIND_WEIGHT[f.kind] * STRENGTH_WEIGHT[f.strength] * (0.5 + size) * tune) }];
  });
  // A mix: not only seasons. At most 5 seasons (2 about people), 3 of any other kind.
  const cap = (f: Finding) => (f.kind === "season" ? (f.person ? "season:person" : "season") : f.kind);
  const limit: Record<string, number> = { season: 5, "season:person": 2 };
  const used = new Map<string, number>();
  const out: Finding[] = [];
  const seasonOf = new Set<string>();
  for (const f of scored.sort((a, b) => b.score - a.score)) {
    // One season finding per signal (or person): "outside less in winter" and "more in summer" are one story.
    if (f.kind === "season") {
      const s = f.person ? `p:${f.person.id}` : f.signal;
      if (seasonOf.has(s)) continue;
      seasonOf.add(s);
    }
    const k = cap(f), n = used.get(k) ?? 0;
    if (n >= (limit[k] ?? 3)) continue;
    used.set(k, n + 1);
    out.push(f);
    if (out.length >= max) break;
  }
  return out;
}

/** The month a gentle reminder would be for: the start of the season (or the month) the contact dips in, next time. */
export function ideaMonth(f: Pick<Finding, "kind" | "season" | "month">, now: Date): number | null {
  if (f.kind === "drift") return (now.getUTCMonth() + 1) % 12;
  if (f.kind !== "season") return null;
  if (f.month !== undefined) return f.month;
  return f.season ? SEASON_MONTHS[f.season][0] : null;
}

/** The last complete week before `now`'s week. */
export function lastFullWeek(nowWeek: string): string {
  return addWeeks(nowWeek, -1);
}

export function yearsSpan(s: Series): number {
  return yearsOfData(s.weeks, s.values);
}

function round(x: number): number {
  return Math.round(x * 100) / 100;
}
const roundN = (x: number | null) => (x === null ? null : round(x));
