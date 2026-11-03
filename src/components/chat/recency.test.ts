import { describe, expect, it } from "vitest";
import { groupByRecency, locatorWords, shortModel, starterQuestions } from "./recency";

const now = new Date(2026, 10, 18, 15, 0); // Wed 18 Nov 2026, local time
const at = (y: number, m: number, d: number, h = 12) => new Date(y, m, d, h).toISOString();

describe("groupByRecency", () => {
  it("buckets conversations from newest to oldest", () => {
    const groups = groupByRecency([
      { id: "old", updatedAt: at(2025, 2, 4) },
      { id: "today", updatedAt: at(2026, 10, 18, 9) },
      { id: "oct", updatedAt: at(2026, 9, 2) },
      { id: "yday", updatedAt: at(2026, 10, 17) },
      { id: "week", updatedAt: at(2026, 10, 14) },
      { id: "month", updatedAt: at(2026, 10, 3) },
    ], now);
    expect(groups.map((g) => g.label)).toEqual(["Today", "Yesterday", "Earlier this week", "Earlier this month", "October", "March 2025"]);
    expect(groups.map((g) => g.items.map((i) => i.id))).toEqual([["today"], ["yday"], ["week"], ["month"], ["oct"], ["old"]]);
  });

  it("returns nothing for an empty list", () => {
    expect(groupByRecency([], now)).toEqual([]);
  });
});

describe("starterQuestions", () => {
  it("writes questions around the family's children and partner", () => {
    const s = starterQuestions([
      { id: "e", name: "Emma Jensen", kind: "child" },
      { id: "n", name: "Noah Jensen", kind: "child" },
      { id: "p", name: "Mads", kind: "partner" },
    ]);
    expect(s[0]).toEqual({ question: "What's coming up for Emma this week?", person: { id: "e", name: "Emma Jensen" } });
    expect(s[1].question).toContain("Noah");
    expect(s[2].person?.id).toBe("p");
    expect(s.length).toBeLessThanOrEqual(5);
  });

  it("falls back to household questions", () => {
    const s = starterQuestions([]);
    expect(s.length).toBeGreaterThanOrEqual(3);
    expect(s.every((x) => !x.person)).toBe(true);
  });
});

describe("labels", () => {
  it("shortens model ids and words locators", () => {
    expect(shortModel("mac-studio/qwen3.6-35b-a3b")).toBe("qwen3.6-35b-a3b");
    expect(shortModel(null)).toBeNull();
    expect(locatorWords({ page: 3 })).toBe("page 3");
    expect(locatorWords({ timeStartSec: 80 })).toBe("at 1:20");
    expect(locatorWords({})).toBeNull();
  });
});
