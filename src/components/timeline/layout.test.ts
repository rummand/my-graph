import { describe, expect, it } from "vitest";
import { clusterPoints, fitText, laneTitle, matchRange, openingRange, packMarks, rangeDomain, upcomingSummary, type LaneMark } from "./layout";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 3, 12);
const measure = (s: string) => s.length * 7;
const pt = (id: string, x: number, labelW = 100): LaneMark => ({ id, x0: x - 7, x1: x + 7, bar: false, labelW });

describe("ranges", () => {
  it("leans towards what is coming", () => {
    const [a, b] = rangeDomain("month", NOW, null);
    expect(NOW - a).toBeLessThan(b - NOW);
  });
  it("recognises a window as its range", () => {
    expect(matchRange(rangeDomain("quarter", NOW, null), NOW, null)).toBe("quarter");
    expect(matchRange([NOW, NOW + 3 * DAY], NOW, null)).toBeNull();
  });
  it("opens on the closest range with something in it", () => {
    const at = (d: number) => ({ start: new Date(NOW + d * DAY).toISOString(), end: null });
    expect(openingRange([at(10)], NOW)).toBe("month");
    expect(openingRange([at(50)], NOW)).toBe("quarter");
    expect(openingRange([at(-120)], NOW)).toBe("year");
    expect(openingRange([at(-900)], NOW)).toBe("all");
  });
});

describe("labels", () => {
  it("drops the lane's own name from a title", () => {
    expect(laneTitle("Emma: Field trip to the Zoo", "Emma")).toBe("Field trip to the Zoo");
    expect(laneTitle("Emma: Field trip", "Emma Hansen")).toBe("Field trip");
    expect(laneTitle("Emma: Field trip", "Noah")).toBe("Emma: Field trip");
  });
  it("cuts text to fit, or gives up", () => {
    expect(fitText("Short", 100, measure)).toBe("Short");
    const cut = fitText("Permission slip deadline", 80, measure)!;
    expect(cut.endsWith("…")).toBe(true);
    expect(measure(cut)).toBeLessThanOrEqual(80);
    expect(fitText("Permission slip deadline", 20, measure)).toBeNull();
  });
});

describe("packing", () => {
  it("merges points that would sit on top of each other", () => {
    const { marks, clusters } = clusterPoints([pt("a", 100), pt("b", 106), pt("c", 300)]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].memberIds).toEqual(["a", "b"]);
    expect(marks).toHaveLength(2);
  });

  it("never lets two labels overlap", () => {
    const marks = [pt("a", 0), pt("b", 30), pt("c", 60), pt("d", 90), pt("e", 400)];
    const { placed, rows } = packMarks(marks, 2);
    expect(rows).toBeLessThanOrEqual(2);
    // Every label's span must stay clear of every other mark/label in its row.
    const spans = marks.map((m) => {
      const p = placed.get(m.id)!;
      const end = p.label.at === "after" ? m.x1 + 6 + p.label.room : m.x1;
      return { row: p.row, x0: m.x0, x1: end };
    });
    for (let i = 0; i < spans.length; i++) for (let j = i + 1; j < spans.length; j++) {
      const s = spans[i], t = spans[j];
      if (s.row !== t.row) continue;
      expect(s.x1 <= t.x0 || t.x1 <= s.x0).toBe(true);
    }
  });

  it("keeps full labels when there is room", () => {
    const { placed, rows } = packMarks([pt("a", 0), pt("b", 300)], 2);
    expect(rows).toBe(1);
    expect(placed.get("a")!.label).toEqual({ at: "after", room: 100 });
  });

  it("puts a label inside a bar that is long enough", () => {
    const { placed } = packMarks([{ id: "bar", x0: 0, x1: 200, bar: true, labelW: 80 }], 2);
    expect(placed.get("bar")!.label.at).toBe("inside");
  });
});

describe("summary", () => {
  it("names the next thing with a readable date", () => {
    const s = upcomingSummary([{ kind: "event", title: "Field trip", start: new Date(Date.UTC(2026, 10, 26, 8)).toISOString() }], NOW);
    expect(s).toBe("One thing in the next 30 days. Next up: Field trip on Thu 26 Nov.");
  });
});
