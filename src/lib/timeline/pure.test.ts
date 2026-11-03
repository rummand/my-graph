import { describe, expect, it } from "vitest";
import {
  calendarDay, chooseTickSpec, dataExtent, deriveStatus, effectivePrecision, formatWhen, groupByMonth, initials, itemExtent,
  laneIdsFor, orderLanes, packLane, packRows, presetDomain, searchItems, tickLabel, type LaneCandidate, type PackInput,
} from "./pure";
import { parseNodeDetail } from "./node-detail";
import { timelineQuerySchema, searchParamsToObject } from "./schemas";
import { FAMILY_LANE } from "./types";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const person = (p: Partial<LaneCandidate> & { id: string }): LaneCandidate => ({
  label: p.id, isViewer: false, isChild: false, isMember: false, birthYear: null, eventCount: 0, ...p,
});

describe("orderLanes", () => {
  it("puts the viewer first, then children by birth year, then members, then others by activity", () => {
    const lanes = orderLanes([
      person({ id: "teacher", label: "Ms Berg", eventCount: 2 }),
      person({ id: "young", label: "Ida", isChild: true, isMember: true, birthYear: 2019 }),
      person({ id: "partner", label: "Mads", isMember: true }),
      person({ id: "me", label: "Anna", isViewer: true, isMember: true }),
      person({ id: "doctor", label: "Dr Holm", eventCount: 5 }),
      person({ id: "old", label: "Karl", isChild: true, isMember: true, birthYear: 2014 }),
      person({ id: "nobirth", label: "Alma", isChild: true, isMember: true }),
      person({ id: "aunt", label: "Aunt Bo", eventCount: 2 }),
    ]);
    expect(lanes.map((l) => l.id)).toEqual(["me", "old", "young", "nobirth", "partner", "doctor", "aunt", "teacher"]);
    expect(lanes.map((l) => l.kind)).toEqual(["viewer", "child", "child", "child", "member", "person", "person", "person"]);
  });

  it("drops duplicates and copes with no viewer", () => {
    const lanes = orderLanes([person({ id: "a", label: "B" }), person({ id: "a", label: "B" }), person({ id: "c", label: "A" })]);
    expect(lanes.map((l) => l.id)).toEqual(["c", "a"]);
  });

  it("sends items with no lane person to Family", () => {
    const set = new Set(["p1", "p2"]);
    expect(laneIdsFor([], set)).toEqual([FAMILY_LANE]);
    expect(laneIdsFor(["zz"], set)).toEqual([FAMILY_LANE]);
    expect(laneIdsFor(["p2", "p1", "p2"], set)).toEqual(["p2", "p1"]);
  });
});

describe("packRows / packLane", () => {
  const it3 = (id: string, x0: number, w = 10, lw = 50): PackInput => ({ id, x0, x1Bare: x0 + w, x1Label: x0 + w + lw });

  it("keeps non-overlapping items on one row with labels", () => {
    const r = packLane([it3("a", 0), it3("b", 100), it3("c", 200)]);
    expect(r.rowCount).toBe(1);
    expect([...r.placed.values()].every((p) => p.row === 0 && p.label)).toBe(true);
  });

  it("stacks overlapping items into the first free row", () => {
    const r = packRows([it3("a", 0), it3("b", 20), it3("c", 40), it3("d", 200)], { gap: 4 });
    expect(r.placed.get("a")!.row).toBe(0);
    expect(r.placed.get("b")!.row).toBe(1);
    expect(r.placed.get("c")!.row).toBe(2);
    expect(r.placed.get("d")!.row).toBe(0);
    expect(r.rowCount).toBe(3);
    expect(r.forced).toBe(0);
  });

  it("is independent of input order", () => {
    const items = [it3("a", 0), it3("b", 20), it3("c", 40)];
    const r1 = packRows(items), r2 = packRows([...items].reverse());
    for (const id of ["a", "b", "c"]) expect(r1.placed.get(id)).toEqual(r2.placed.get(id));
  });

  it("respects maxRows, then hides labels instead of overlapping", () => {
    const items = Array.from({ length: 6 }, (_, i) => it3(`e${i}`, i * 12, 10, 80));
    const withLabels = packRows(items, { maxRows: 2 });
    expect(withLabels.forced).toBeGreaterThan(0);
    const lane = packLane(items, { maxRows: 2, gap: 4 });
    expect(lane.rowCount).toBeLessThanOrEqual(2);
    const rows = [...lane.placed.values()].map((p) => p.row);
    expect(Math.max(...rows)).toBeLessThan(2);
    // Bare marks (10px) every 12px alternate rows without colliding.
    expect(rows).toEqual([0, 1, 0, 1, 0, 1]);
    // Only the last item in each row has room for its label.
    expect([...lane.placed.entries()].filter(([, p]) => p.label).map(([id]) => id).sort()).toEqual(["e4", "e5"]);
  });

  it("handles an empty lane", () => {
    expect(packLane([]).rowCount).toBe(1);
  });
});

describe("chooseTickSpec", () => {
  const W = 1000;
  it("uses years for decades", () => expect(chooseTickSpec(30 * 365 * DAY, W)).toEqual({ unit: "year", step: 5 }));
  it("uses single years for a few years", () => expect(chooseTickSpec(10 * 365 * DAY, W)).toEqual({ unit: "year", step: 1 }));
  it("uses months for a year", () => expect(chooseTickSpec(365 * DAY, W)).toEqual({ unit: "month", step: 1 }));
  it("uses weeks for a couple of months", () => expect(chooseTickSpec(70 * DAY, W)).toEqual({ unit: "week", step: 1 }));
  it("uses days for a week or two", () => expect(chooseTickSpec(10 * DAY, W)).toEqual({ unit: "day", step: 1 }));
  it("uses hours for a day", () => expect(chooseTickSpec(DAY, W).unit).toBe("hour"));
  it("gets coarser as the plot narrows", () => {
    expect(chooseTickSpec(365 * DAY, 300)).toEqual({ unit: "month", step: 3 });
  });
  it("falls back on bad input", () => expect(chooseTickSpec(0, W)).toEqual({ unit: "year", step: 1 }));
  it("labels Januaries with the year", () => {
    expect(tickLabel(new Date(2021, 0, 1), { unit: "month", step: 1 })).toBe("2021");
    expect(tickLabel(new Date(2021, 2, 1), { unit: "month", step: 1 })).toBe("Mar");
    expect(tickLabel(new Date(2021, 2, 1, 14), { unit: "hour", step: 1 })).toBe("14:00");
  });
});

describe("formatWhen", () => {
  const utc = (y: number, m: number, d = 1, h = 0, mi = 0) => new Date(Date.UTC(y, m - 1, d, h, mi));
  it("formats by precision", () => {
    expect(formatWhen(utc(2021, 3), null, "year")).toBe("2021");
    expect(formatWhen(utc(2021, 3), null, "month")).toBe("March 2021");
    expect(formatWhen(utc(2021, 3, 14), null, "day")).toBe("14 March 2021");
    const local = new Date(2021, 2, 14, 9, 5);
    expect(formatWhen(local, null, "minute")).toBe("14 March 2021, 09:05");
  });

  it("reads local-midnight and morning day dates as the intended day", () => {
    // 00:00 Copenhagen (UTC+1) is 23:00 UTC the day before.
    expect(formatWhen(new Date("2021-03-13T23:00:00Z"), null, "day")).toBe("14 March 2021");
    expect(formatWhen(new Date("2021-03-14T06:00:00Z"), null, "day")).toBe("14 March 2021");
    expect(formatWhen(new Date("2021-02-28T23:00:00Z"), null, "month")).toBe("March 2021");
  });

  it("collapses shared parts of ranges", () => {
    expect(formatWhen(utc(2021, 3, 3), utc(2021, 3, 7), "day")).toBe("3 – 7 March 2021");
    expect(formatWhen(utc(2021, 3, 3), utc(2021, 4, 7), "day")).toBe("3 March – 7 April 2021");
    expect(formatWhen(utc(2020, 12, 30), utc(2021, 1, 2), "day")).toBe("30 December 2020 – 2 January 2021");
    expect(formatWhen(utc(2021, 3), utc(2021, 6), "month")).toBe("March – June 2021");
    expect(formatWhen(utc(2019, 1), utc(2021, 1), "year")).toBe("2019 – 2021");
    expect(formatWhen(new Date(2021, 2, 3, 14, 30), new Date(2021, 2, 3, 16, 0), "minute")).toBe("3 March 2021, 14:30 – 16:00");
  });

  it("ignores an end that adds nothing", () => {
    expect(formatWhen(utc(2021, 3, 3), utc(2021, 3, 3), "day")).toBe("3 March 2021");
    expect(formatWhen(utc(2021, 3, 9), utc(2021, 3, 3), "day")).toBe("9 March 2021");
  });

  it("guesses precision when none was recorded", () => {
    expect(effectivePrecision(utc(2021, 3, 3), null)).toBe("day");
    expect(effectivePrecision(utc(2021, 3, 3, 10, 15), null)).toBe("minute");
    expect(effectivePrecision(utc(2021, 3, 3, 10, 15), "year")).toBe("year");
    expect(calendarDay(utc(2021, 3, 3)).getDate()).toBe(3);
  });
});

describe("extents, grouping and presets", () => {
  it("widens month/year points to their whole period", () => {
    const e = itemExtent({ start: "2021-03-01T00:00:00Z", end: null, precision: "month" });
    expect(e.fuzzy).toBe(true);
    expect(new Date(e.t0).getMonth()).toBe(2);
    expect(new Date(e.t1).getMonth()).toBe(3);
    const p = itemExtent({ start: "2021-03-05T10:00:00Z", end: null, precision: "minute" });
    expect(p.t1).toBe(p.t0);
    expect(dataExtent([])).toBeNull();
  });

  it("groups by month in order", () => {
    const g = groupByMonth([
      { start: "2021-04-02T00:00:00Z", precision: "day" as const, id: "b" },
      { start: "2021-03-20T00:00:00Z", precision: "day" as const, id: "a" },
      { start: "2021-04-20T00:00:00Z", precision: "day" as const, id: "c" },
    ]);
    expect(g.map((x) => x.label)).toEqual(["March 2021", "April 2021"]);
    expect(g[1].items.map((x) => x.id)).toEqual(["b", "c"]);
  });

  it("builds preset windows around now", () => {
    const now = new Date(Date.UTC(2026, 10, 3));
    const [a, b] = presetDomain("week", now, null);
    expect((b.getTime() - a.getTime()) / DAY).toBe(7);
    const [c, d] = presetDomain("all", now, [now.getTime() - 400 * DAY, now.getTime() - 300 * DAY]);
    expect(c.getTime()).toBeLessThan(now.getTime() - 400 * DAY);
    expect(d.getTime()).toBeGreaterThan(now.getTime()); // always includes today
  });
});

describe("deriveStatus", () => {
  it("prefers explicit status, then hand entries, then inference", () => {
    expect(deriveStatus({ status: "inferred" }, [{ activity: "manual_edit", agentType: "user" }])).toBe("inferred");
    expect(deriveStatus({}, [{ activity: "llm_extraction", agentType: "model" }, { activity: "manual_edit", agentType: "user" }])).toBe("confirmed");
    expect(deriveStatus({}, [{ activity: "inference", agentType: "model" }])).toBe("inferred");
    expect(deriveStatus({}, [{ activity: "llm_extraction", agentType: "model" }])).toBe("unconfirmed");
    expect(deriveStatus(null, [])).toBe("unconfirmed");
    expect(deriveStatus({ status: "bogus" }, [{ activity: "inference", agentType: "rule" }])).toBe("inferred");
  });
});

describe("search and helpers", () => {
  const items = [
    { title: "Dentist", summary: null },
    { title: "School trip to Århus", summary: "Bring packed lunch" },
    { title: "Parent meeting", summary: "About the school trip" },
  ];
  it("matches titles first, accent-insensitive, then summaries", () => {
    expect(searchItems(items, "arhus").map((i) => i.title)).toEqual(["School trip to Århus"]);
    expect(searchItems(items, "school").map((i) => i.title)).toEqual(["School trip to Århus", "Parent meeting"]);
    expect(searchItems(items, "  ")).toEqual([]);
  });
  it("makes initials", () => {
    expect(initials("Ida Marie Hansen")).toBe("IH");
    expect(initials("Karl")).toBe("K");
    expect(initials(" ")).toBe("?");
  });
});

describe("parseNodeDetail", () => {
  it("reads sources defensively and dedupes by source", () => {
    const d = parseNodeDetail({
      node: { summary: "Trip to the zoo" },
      neighbours: [{ id: "p", type: "person", label: "Ida" }, { id: "z", type: "place", label: "Zoo" }, { bad: true }],
      provenance: {
        node: [
          { id: "1", sourceId: "s1", sourceTitle: "Letter", locator: { page: 2 }, quote: "Zoo on Friday", activity: "llm_extraction", confidence: 0.7 },
          { id: "2", sourceId: "s1", sourceTitle: "Letter", locator: { page: 2 }, quote: "Zoo Friday 9:00", activity: "llm_extraction", confidence: 0.9 },
          { id: "3", sourceId: null, activity: "manual_edit" },
          "junk",
        ],
      },
    });
    expect(d.summary).toBe("Trip to the zoo");
    expect(d.sources).toHaveLength(1);
    expect(d.sources[0]).toMatchObject({ sourceId: "s1", title: "Letter", detail: "page 2", confidence: 0.9, quote: "Zoo Friday 9:00" });
    expect(d.related).toEqual([{ id: "z", type: "place", label: "Zoo" }]);
  });
  it("survives garbage", () => {
    expect(parseNodeDetail(null)).toEqual({ summary: null, sources: [], related: [] });
    expect(parseNodeDetail({ provenance: "x", neighbours: 3 })).toEqual({ summary: null, sources: [], related: [] });
  });
});

describe("timelineQuerySchema", () => {
  const id = "123e4567-e89b-42d3-a456-426614174000";
  it("parses lists and dates", () => {
    const q = timelineQuerySchema.parse(searchParamsToObject(new URLSearchParams(`from=2021-01-01&to=2021-12-31T00:00:00Z&people=${id},${id}&types=event,source`)));
    expect(q.people).toEqual([id]);
    expect(q.types).toEqual(["event", "source"]);
    expect(q.from).toBe("2021-01-01");
  });
  it("treats blanks as missing", () => {
    expect(timelineQuerySchema.parse({ from: "", people: "", types: "" })).toEqual({});
  });
  it("rejects bad input", () => {
    expect(timelineQuerySchema.safeParse({ people: "nope" }).success).toBe(false);
    expect(timelineQuerySchema.safeParse({ types: "photos" }).success).toBe(false);
    expect(timelineQuerySchema.safeParse({ from: "2022-01-01", to: "2021-01-01" }).success).toBe(false);
    expect(timelineQuerySchema.safeParse({ from: "yesterday" }).success).toBe(false);
  });
});
