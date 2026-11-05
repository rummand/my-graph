import { describe, expect, it } from "vitest";
import { makeT, type MessageTree } from "@/lib/i18n/core";
import enYou from "@/lib/i18n/messages/en/you";
import daYou from "@/lib/i18n/messages/da/you";
import { asksAboutSelf, isOwn, ownRowsOnly, youAllowed, youOnByDefault } from "./gate";
import { findPatterns, rank, type SignalSet } from "./patterns";
import { addWeeks, localDay, mondayOf, monthOfWeek, monthProfile, spanDays, weekly, weeksBetween } from "./series";
import { anomaly, contrast, drift, lagCorrelation, seasonality, streak } from "./stats";
import type { Finding, Series } from "./types";
import { classifyEvent, lateAt, lexiconTone } from "./signals";
import { BANNED, bannedWords, ideaFor, noteFor, rawSentence, sentenceFor, strengthLine } from "./wording";

const T = { en: makeT("en", { you: enYou }), da: makeT("da", { you: daYou }, { you: enYou }) };

/** A deterministic pseudo-random stream (no Math.random in tests). */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; };
}

/** Weekly series over `years` years ending at 2026-10-26, value by month. */
function synthetic(years: number, byMonth: (month: number, year: number, r: () => number) => number | null, seed = 1): Series {
  const to = "2026-10-26";
  const from = addWeeks(to, -52 * years - 1);
  const weeks = weeksBetween(from, to);
  const r = rng(seed);
  const values = weeks.map((w) => { const { month, year } = monthOfWeek(w); return byMonth(month, year, r); });
  const total = values.reduce<number>((a, b) => a + (b ?? 0), 0);
  return { key: "x", weeks, values, total, first: weeks[values.findIndex((v) => v !== null && v !== 0)] ?? null };
}

describe("weekly series", () => {
  it("names weeks by their Monday in the person's time zone", () => {
    expect(mondayOf("2026-11-05")).toBe("2026-11-02"); // a Thursday
    expect(mondayOf("2026-11-08")).toBe("2026-11-02"); // Sunday belongs to the week before
    expect(mondayOf("2026-11-09")).toBe("2026-11-09");
    // 23:30 UTC on Sunday is already Monday in Copenhagen.
    expect(localDay("2026-11-08T23:30:00Z", "Europe/Copenhagen")).toBe("2026-11-09");
    expect(weeksBetween("2026-10-05", "2026-11-02")).toEqual(["2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26", "2026-11-02"]);
  });
  it("puts a week in the month of its Thursday", () => {
    expect(monthOfWeek("2026-09-28")).toEqual({ year: 2026, month: 9 }); // Thu 1 Oct
    expect(monthOfWeek("2026-12-28")).toEqual({ year: 2026, month: 11 }); // Thu 31 Dec
  });
  it("sums, counts days, and keeps empty weeks of a mean as no reading", () => {
    const pts = [
      { at: "2026-10-05T09:00:00Z" }, { at: "2026-10-05T15:00:00Z" }, { at: "2026-10-07T10:00:00Z" },
      { at: "2026-10-20T10:00:00Z", value: 3 },
    ];
    const opts = { fromWeek: "2026-10-05", toWeek: "2026-10-26", tz: "Europe/Copenhagen" };
    expect(weekly("a", pts, { ...opts, agg: "sum" }).values).toEqual([3, 0, 3, 0]);
    expect(weekly("a", pts, { ...opts, agg: "days" }).values).toEqual([2, 0, 1, 0]);
    const mean = weekly("m", [{ at: "2026-10-05T09:00:00Z", value: 0.5 }, { at: "2026-10-06T09:00:00Z", value: -0.5 }], { ...opts, agg: "mean" });
    expect(mean.values).toEqual([0, null, null, null]);
    expect(mean.total).toBe(2);
    expect(weekly("a", pts, opts).first).toBe("2026-10-05");
  });
  it("spreads a trip over its days", () => {
    expect(spanDays("2026-07-03T00:00:00Z", "2026-07-05T23:59:00Z", "UTC")).toHaveLength(3);
  });
  it("profiles twelve months across years", () => {
    const s = synthetic(3, (m) => (m === 6 ? 10 : 2));
    const p = monthProfile(s);
    expect(p[6]).toBe(10);
    expect(p[1]).toBe(2);
  });
});

describe("seasonality", () => {
  it("finds a dip every autumn over three years", () => {
    const s = synthetic(3, (m, _y, r) => ([8, 9, 10].includes(m) ? 1 + r() : 4 + r() * 2));
    const hits = seasonality(s);
    const autumn = hits.find((h) => h.season === "autumn");
    expect(autumn).toMatchObject({ direction: "down" });
    expect(autumn!.ratio).toBeLessThan(0.6);
    expect(autumn!.years.length).toBeGreaterThanOrEqual(2);
  });
  it("prefers the single month when it carries the pattern", () => {
    const s = synthetic(4, (m, _y, r) => (m === 10 ? 9 + r() : 2 + r()));
    const hits = seasonality(s);
    expect(hits.find((h) => h.month === 10)).toMatchObject({ direction: "up" });
    expect(hits.find((h) => h.season === "autumn")).toBeUndefined();
  });
  it("needs two full years, and the same direction in every year", () => {
    const short = synthetic(1, (m) => ([8, 9, 10].includes(m) ? 1 : 5));
    expect(seasonality(short)).toEqual([]);
    // Autumn low one year, high the next: no pattern.
    const flip = synthetic(3, (m, y) => ([8, 9, 10].includes(m) ? (y % 2 ? 1 : 9) : 4));
    expect(seasonality(flip).filter((h) => h.season === "autumn")).toEqual([]);
  });
  it("isn't carried by one unusual year", () => {
    // Autumn was nearly empty in the last year only (a friendship fading lately), ordinary before.
    const s = synthetic(3, (m, y, r) => ([8, 9, 10].includes(m) && y === 2026 ? 0.1 : 3 + r() * 0.4 - ([8, 9, 10].includes(m) ? 0.2 : 0)));
    expect(seasonality(s).filter((h) => h.season === "autumn")).toEqual([]);
  });
  it("doesn't call every other month low because one month is very full", () => {
    const s = synthetic(3, (m, _y, r) => (m === 10 ? 12 : 3 + r() * 0.3));
    expect(seasonality(s).filter((h) => h.direction === "down")).toEqual([]);
  });
  it("says nothing about noise", () => {
    const s = synthetic(4, (_m, _y, r) => 3 + r() * 2, 7);
    expect(seasonality(s)).toEqual([]);
  });
});

describe("lagged correlation", () => {
  const n = 60;
  const r = rng(3);
  const x = Array.from({ length: n }, () => Math.round(r() * 5));
  it("finds y following x a week later", () => {
    const noise = rng(9);
    const y = [0, ...x.slice(0, -1).map((v) => v * 0.2 + (noise() - 0.5) * 0.3)];
    const c1 = lagCorrelation(x, y, 1);
    const c0 = lagCorrelation(x, y, 0);
    expect(c1.ok).toBe(true);
    expect(c1.r).toBeGreaterThan(0.8);
    expect(Math.abs(c0.r)).toBeLessThan(Math.abs(c1.r));
  });
  it("refuses fewer than 12 weeks, however strong", () => {
    const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const c = lagCorrelation(xs, xs.map((v) => v * 2), 0);
    expect(c.r).toBeCloseTo(1);
    expect(c.ok).toBe(false);
  });
  it("skips weeks without a reading and refuses weak or flat relations", () => {
    const y = x.map((v, i) => (i % 3 ? null : v));
    expect(lagCorrelation(x, y, 0).n).toBe(20);
    const flat = x.map(() => 2);
    expect(lagCorrelation(x, flat, 0).ok).toBe(false);
    const rr = rng(5);
    const unrelated = x.map(() => rr());
    expect(lagCorrelation(x, unrelated, 0).ok).toBe(false);
  });
  it("contrasts one kind of week with the rest", () => {
    const mask = Array.from({ length: 40 }, (_, i) => i % 2 === 0);
    const y = mask.map((m, i) => (m ? 0.6 : -0.1) + ((i * 7) % 5) / 20);
    const c = contrast(y, mask);
    expect(c.ok).toBe(true);
    expect(c.d).toBeGreaterThan(0.5);
    expect(contrast(y.slice(0, 8), mask.slice(0, 8)).ok).toBe(false);
  });
});

describe("anomaly, drift and streaks against the person's own baseline", () => {
  it("flags four unusually full weeks after a steady year", () => {
    const r = rng(11);
    const base = Array.from({ length: 52 }, () => 5 + Math.round(r() * 2));
    const a = anomaly([...base, 14, 15, 13, 16]);
    expect(a.ok).toBe(true);
    expect(a.direction).toBe("up");
    expect(a.ratio).toBeGreaterThan(2);
  });
  it("stays quiet within the usual range, and without enough baseline", () => {
    const r = rng(12);
    const base = Array.from({ length: 52 }, () => 5 + Math.round(r() * 2));
    expect(anomaly([...base, 6, 5, 7, 6]).ok).toBe(false);
    expect(anomaly([5, 6, 5, 6, 5, 6, 20, 20, 20, 20]).ok).toBe(false);
  });
  it("sees contact fading", () => {
    const vals = [...Array.from({ length: 40 }, (_, i) => (i % 2 ? 2 : 1)), ...Array.from({ length: 12 }, () => 0)];
    expect(drift(vals)).toMatchObject({ ok: true });
    expect(drift(vals.map(() => 1)).ok).toBe(false);
  });
  it("counts weeks in a row", () => {
    expect(streak([0, 1, 0, 2, 1, 1])).toBe(3);
    expect(streak([1, 0])).toBe(0);
  });
});

describe("what rows count as", () => {
  const tz = "Europe/Copenhagen";
  it("never counts health events, and sorts the rest", () => {
    const at = new Date("2026-10-06T08:00:00Z"); // a Tuesday morning
    expect(classifyEvent({ kind: "appointment", startAt: at, endAt: null, props: { health: "visit" } }, tz)).toBeNull();
    expect(classifyEvent({ kind: null, startAt: at, endAt: new Date(at.getTime() + 3_600_000), props: {} }, tz)).toMatchObject({ meeting: true, evening: false, hours: 1 });
    expect(classifyEvent({ kind: null, startAt: new Date("2026-10-06T17:30:00Z"), endAt: null, props: {} }, tz)).toMatchObject({ meeting: true, evening: true });
    expect(classifyEvent({ kind: "trip", startAt: at, endAt: null, props: { allDay: true } }, tz)).toMatchObject({ away: true, outdoorsDays: true, meeting: false });
    expect(classifyEvent({ kind: "activity", startAt: at, endAt: null, props: {} }, tz)).toMatchObject({ outdoorsDays: true, meeting: false });
    expect(classifyEvent({ kind: null, startAt: at, endAt: null, props: { allDay: true } }, tz)).toBeNull();
  });
  it("knows when something said yes to ran late", () => {
    const now = new Date("2026-11-05T12:00:00Z");
    expect(lateAt({ status: "open", dueAt: "2026-10-01T00:00:00Z" }, now)).not.toBeNull();
    expect(lateAt({ status: "open", dueAt: "2026-11-20T00:00:00Z" }, now)).toBeNull();
    expect(lateAt({ status: "done", dueAt: "2026-10-01T00:00:00Z", doneAt: "2026-09-30T00:00:00Z" }, now)).toBeNull();
    expect(lateAt({ status: "done", dueAt: "2026-10-01T00:00:00Z", doneAt: "2026-10-09T00:00:00Z" }, now)).not.toBeNull();
    expect(lateAt({ status: "cancelled", dueAt: "2026-10-01T00:00:00Z" }, now)).toBeNull();
  });
  it("reads a tone from a person's own words in English and Danish", () => {
    expect(lexiconTone("Good week, rested and happy")).toBe(1);
    expect(lexiconTone("Træt og stresset, alt for meget")).toBe(-1);
    expect(lexiconTone("Bought milk")).toBeNull();
  });
});

describe("findings end to end", () => {
  it("finds that contact with Lars drops every autumn, with receipts and a ring chart", () => {
    const lars = synthetic(3, (m, _y, r) => ([8, 9, 10].includes(m) ? (r() < 0.3 ? 1 : 0) : 2 + Math.round(r() * 2)));
    const set: SignalSet = {
      series: {}, refs: {}, graphKind: "personal",
      people: [{ id: "lars", name: "Lars", series: lars, refs: new Map([[lars.weeks[lars.weeks.length - 5], [{ href: "/library/s1", title: "WhatsApp with Lars" }]]]) }],
    };
    const f = findPatterns(set);
    const autumn = f.find((x) => x.key.startsWith("season:contact:lars:"));
    expect(autumn).toBeDefined();
    expect(autumn!.direction).toBe("down");
    expect(autumn!.chart.type).toBe("ring");
    expect(autumn!.receipts.counts.find((c) => c.key === "years")!.n).toBeGreaterThanOrEqual(2);
    expect(rawSentence(autumn!, T.en)).toMatch(/^Your contact with Lars drops every (autumn|September|October|November)\.$/);
    expect(rawSentence(autumn!, T.da)).toMatch(/^Din kontakt med Lars falder (hvert efterår|hver (september|oktober|november))\.$/);
    expect(ideaFor(autumn!, T.en, new Date("2026-11-05"))?.text).toMatch(/^Want a reminder to get in touch with Lars in (September|October|November)\?$/);
  });
  it("ranks with feedback: 'not really' drops an early pattern, 'yes' lifts one", () => {
    const base: Omit<Finding, "key" | "strength"> = { kind: "season", signal: "meetings", direction: "up", effect: 1.6, span: { years: 2 }, n: 2, chart: { type: "bars", a: 1, b: 1 }, receipts: { counts: [], weeks: [], links: [] }, score: 0 };
    const a: Finding = { ...base, key: "season:meetings:autumn:up", season: "autumn", strength: "early" };
    const b: Finding = { ...base, key: "season:outdoors:summer:up", signal: "outdoors", season: "summer", strength: "fair" };
    expect(rank([a, b], new Map([["season:meetings:autumn:up", "no"]])).map((x) => x.key)).toEqual(["season:outdoors:summer:up"]);
    const lifted = rank([a, b], new Map([["season:meetings:autumn:up", "yes"]]));
    expect(lifted[0].key).toBe("season:meetings:autumn:up");
  });
});

describe("wording", () => {
  /** Every sentence template, rendered with sample values. */
  function allSentences(tree: MessageTree, t: ReturnType<typeof makeT>): string[] {
    const out: string[] = [];
    const walk = (node: MessageTree, path: string) => {
      for (const [k, v] of Object.entries(node)) {
        const key = `${path}.${k}`;
        if (typeof v === "string" || ("one" in v && "other" in v)) out.push(t(key, { when: "x", name: "Lars", pct: 30, times: 2, count: 3, x: "x", y: "y", signal: "s", span: "3", month: "m" }));
        else walk(v as MessageTree, key);
      }
    };
    for (const part of ["say", "more", "less", "when", "strength", "idea", "signal", "month"]) walk({ [part]: tree[part] } as MessageTree, "you");
    return out;
  }
  it("never uses diagnostic, blaming or causal words, in English or Danish", () => {
    for (const [locale, tree] of [["en", enYou], ["da", daYou]] as const) {
      const sentences = allSentences(tree, T[locale]);
      expect(sentences.length).toBeGreaterThan(80);
      for (const s of sentences) expect(bannedWords(s, locale), s).toEqual([]);
    }
  });
  it("catches the words it bans", () => {
    expect(bannedWords("You seem depressed in autumn", "en")).toEqual(["depress"]);
    expect(bannedWords("Meetings cause your stress", "en")).toContain("cause");
    expect(bannedWords("Du er deprimeret fordi", "da")).toEqual(expect.arrayContaining(["deprimeret", "fordi"]));
    expect(bannedWords("Your contact with Lars drops every autumn.", "en")).toEqual([]);
    expect(BANNED.en.length).toBeGreaterThan(20);
  });
  it("has the same keys in English and Danish", () => {
    const keys = (n: MessageTree, p = ""): string[] => Object.entries(n).flatMap(([k, v]) => (typeof v === "string" || ("one" in v && "other" in v) ? [`${p}${k}`] : keys(v as MessageTree, `${p}${k}.`)));
    expect(keys(daYou).sort()).toEqual(keys(enYou).sort());
  });
  it("says how firm a pattern is, and that going together isn't cause", () => {
    expect(strengthLine({ strength: "fair", span: { years: 3 } }, T.en)).toBe("A fairly clear pattern over 3 years.");
    expect(strengthLine({ strength: "early", span: { weeks: 14 } }, T.da)).toBe("Et tidligt mønster over 14 uger; det kan ændre sig.");
    const corr = { key: "corr:outdoors:mood:1", kind: "correlation", signal: "mood", other: "outdoors", direction: "up", lag: 1, effect: 0.5, span: { weeks: 40 }, n: 40, strength: "fair", chart: { type: "bars", a: 1, b: 1 }, receipts: { counts: [], weeks: [], links: [] }, score: 0 } as Finding;
    expect(sentenceFor(corr, T.en, "en")).toBe("Weeks with more time outdoors tend to be followed by brighter words in your own notes the week after.");
    expect(noteFor(corr, T.en, false)).toMatch(/doesn't mean one leads to the other/);
  });
});

describe("privacy", () => {
  it("only the person themself, never guests, only with the feature", () => {
    expect(youAllowed({ featureOn: true, role: "parent" })).toBe(true);
    expect(youAllowed({ featureOn: true, role: "child" })).toBe(true);
    expect(youAllowed({ featureOn: true, role: "guest" })).toBe(false);
    expect(youAllowed({ featureOn: false, role: "owner" })).toBe(false);
  });
  it("starts off for children", () => {
    expect(youOnByDefault("child")).toBe(false);
    expect(youOnByDefault("owner")).toBe(true);
    expect(youOnByDefault("parent")).toBe(true);
    expect(youOnByDefault("guest")).toBe(false);
  });
  it("reads only the viewer's own rows", () => {
    expect(isOwn("anna", { userId: "anna" })).toBe(true);
    expect(isOwn("peter", { userId: "anna" })).toBe(false);
  });
  it("combining graphs keeps only what the person added themself in the other graphs", () => {
    const rows = [
      { id: 1, ownerId: "anna", graphId: "family" },
      { id: 2, ownerId: "peter", graphId: "family" },
      { id: 3, ownerId: "anna", graphId: "work" },
      { id: 4, ownerId: "colleague", graphId: "work" },
    ];
    expect(ownRowsOnly(rows, "anna", "family").map((r) => r.id)).toEqual([1, 2, 3]);
  });
  it("knows when someone asks about themself", () => {
    expect(asksAboutSelf("Why am I so tired lately?")).toBe(true);
    expect(asksAboutSelf("Hvorfor er jeg så træt for tiden?")).toBe(true);
    expect(asksAboutSelf("When is Emma's dentist appointment?")).toBe(false);
    expect(asksAboutSelf("Is Peter tired lately?")).toBe(false);
  });
});
