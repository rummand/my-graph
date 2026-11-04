import { describe, expect, it } from "vitest";
import { graphStyle, groupGraphs, joinNames, sharingLine, whoSeesWhat, type GraphView } from "./describe";

const anna = { userId: "a", name: "Anna Holm", colorId: "a", role: "owner" as const };
const sara = { userId: "s", name: "Sara Berg", colorId: "s", role: "editor" as const };
const mikkel = { userId: "m", name: "Mikkel Holm", colorId: "m", role: "editor" as const };

function g(p: Partial<GraphView>): GraphView {
  return {
    id: "x", name: "X", description: null, kind: "shared", color: 340, myRole: "owner", memberCount: 1, isFamily: false,
    isCurrent: false, ownerId: "a", createdAt: "2026-11-01T00:00:00Z", members: [anna], ...p,
  };
}

const family = g({ id: "f", name: "Family", kind: "family", isFamily: true, members: [anna, mikkel] });
const work = g({ id: "w", name: "Work", kind: "work" });
const forSara = g({ id: "fs", name: "For Sara", members: [anna, sara] });

describe("joinNames", () => {
  it("reads like a sentence", () => {
    expect(joinNames(["Sara"])).toBe("Sara");
    expect(joinNames(["Sara", "Mikkel"])).toBe("Sara and Mikkel");
    expect(joinNames(["A", "B", "C"])).toBe("A, B and C");
    expect(joinNames(["A", "B", "C", "D"])).toBe("A, B and 2 others");
  });
});

describe("sharingLine", () => {
  it("names who a graph is shared with", () => {
    expect(sharingLine(forSara, "a")).toBe("Shared with Sara");
    expect(sharingLine(work, "a")).toBeNull();
    expect(sharingLine({ ...forSara, myRole: "editor" }, "s")).toBe("Shared by Anna");
    expect(sharingLine(family, "a")).toBe("The family, 2 people");
  });
});

describe("whoSeesWhat", () => {
  const all = [family, work, forSara];
  it("tells the owner that the other graphs stay private", () => {
    expect(whoSeesWhat(forSara, all, "a")).toBe("Sara sees only what is in this graph. Your Family and Work graphs stay private.");
  });
  it("reassures the person it was shared with", () => {
    expect(whoSeesWhat({ ...forSara, myRole: "editor" }, [{ ...forSara, myRole: "editor" }], "s"))
      .toBe("You see only what is in this graph. Anna's other graphs stay private, and nothing from your own graphs is shared with Anna.");
  });
  it("explains an unshared graph", () => {
    expect(whoSeesWhat(work, all, "a")).toMatch(/^Only you can see this graph\./);
  });
});

describe("groupGraphs", () => {
  it("puts the family graph and owned graphs under Mine", () => {
    const shared = g({ id: "o", myRole: "viewer", ownerId: "z" });
    const r = groupGraphs([family, work, shared]);
    expect(r.mine.map((x) => x.id)).toEqual(["f", "w"]);
    expect(r.shared.map((x) => x.id)).toEqual(["o"]);
  });
});

describe("graphStyle", () => {
  it("wraps hues into range", () => {
    expect(graphStyle(370)["--g"]).toBe("oklch(0.64 0.14 10)");
    expect(graphStyle(-20)["--g"]).toBe("oklch(0.64 0.14 340)");
  });
});

describe("in Danish", () => {
  // Imported lazily so the English tests above stay independent of the Danish file.
  it("reads naturally", async () => {
    const { makeT } = await import("@/lib/i18n/core");
    const da = (await import("@/lib/i18n/messages/da/graphs")).default;
    const en = (await import("@/lib/i18n/messages/en/graphs")).default;
    const t = makeT("da", { graphs: da }, { graphs: en });
    expect(sharingLine(forSara, "a", t)).toBe("Delt med Sara");
    expect(sharingLine(family, "a", t)).toBe("Familien, 2 personer");
    expect(joinNames(["A", "B", "C", "D"], 3, t)).toBe("A, B og 2 andre");
    expect(whoSeesWhat(forSara, [family, work, forSara], "a", t)).toBe("Sara ser kun det, der er i denne graf. Dine grafer Family og Work forbliver private.");
  });
});
