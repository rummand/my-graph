import { describe, expect, it } from "vitest";
import {
  defaultEdgeStatus, editSimilarity, isRelevant, RELEVANCE, findMergePairs, humanizeRelation, levenshtein, mergeAliases, namesMatch, nameSimilarity,
  narrowerVisibility, noisyOr, normalizeLabel, normalizeRelation, rrfFuse, statusAfterReassert, toAnyPrefixTsQuery,
  toPrefixTsQuery, tokenJaccard, vectorLiteral,
} from "./pure";

describe("normalizeLabel", () => {
  it("ignores case, accents and punctuation", () => {
    expect(normalizeLabel("  Dr. José-María  ")).toBe("dr jose maria");
  });
  it("transliterates Danish letters", () => {
    expect(normalizeLabel("Århus")).toBe(normalizeLabel("Aarhus"));
    expect(normalizeLabel("Søren Kærgård")).toBe("soeren kaergaard");
  });
  it("returns empty for punctuation only", () => expect(normalizeLabel("—!?")).toBe(""));
});

describe("names", () => {
  it("matches label against aliases", () => {
    expect(namesMatch({ label: "Mormor" }, { label: "Inge", aliases: ["mormor"] })).toBe(true);
    expect(namesMatch({ label: "Anna" }, { label: "Anne" })).toBe(false);
  });
  it("merges aliases without repeating the label or variants", () => {
    expect(mergeAliases("Anna", ["anna", "Annie"], ["ANNIE", " Nanna ", ""])).toEqual(["Annie", "Nanna"]);
  });
});

describe("similarity", () => {
  it("levenshtein", () => {
    expect(levenshtein("kitten", "sitting")).toBe(3);
    expect(levenshtein("", "abc")).toBe(3);
    expect(levenshtein("same", "same")).toBe(0);
  });
  it("edit similarity is normalised", () => {
    expect(editSimilarity("Anna", "anna")).toBe(1);
    expect(editSimilarity("Katrine", "Katrina")).toBeCloseTo(1 - 1 / 7);
  });
  it("token jaccard", () => {
    expect(tokenJaccard("Anna Hansen", "Hansen Anna")).toBe(1);
    expect(tokenJaccard("Anna Hansen", "Peter Hansen")).toBeCloseTo(1 / 3);
  });
  it("explains the reason", () => {
    expect(nameSimilarity({ label: "Søren" }, { label: "soren" })).toMatchObject({ score: expect.any(Number) });
    expect(nameSimilarity({ label: "Anna" }, { label: "ANNA" }).score).toBe(1);
    expect(nameSimilarity({ label: "Hansen" }, { label: "Dr. Hansen" })).toMatchObject({ score: 0.8 });
    expect(nameSimilarity({ label: "Farfar" }, { label: "Jens", aliases: ["farfar"] }).score).toBe(0.95);
    expect(nameSimilarity({ label: "Bo" }, { label: "Bob" }).score).toBeLessThan(0.75);
  });
});

describe("findMergePairs", () => {
  const items = [
    { id: "1", type: "person", label: "Katrine Hansen", aliases: [] },
    { id: "2", type: "person", label: "Katrina Hansen", aliases: [] },
    { id: "3", type: "place", label: "Katrine Hansen", aliases: [] },
    { id: "4", type: "person", label: "Peter", aliases: [] },
    { id: "5", type: "person", label: "Katrine Hansen", aliases: [], notSame: ["1"] },
  ];
  it("pairs same-type look-alikes only, best first, honouring 'not the same'", () => {
    const pairs = findMergePairs(items);
    expect(pairs.map((p) => [p.aId, p.bId].sort().join("-")).sort()).toEqual(["1-2", "2-5"]);
    expect(pairs.some((p) => [p.aId, p.bId].includes("3"))).toBe(false);
    expect(pairs.some((p) => [p.aId, p.bId].sort().join("-") === "1-5")).toBe(false);
    expect(pairs.some((p) => [p.aId, p.bId].includes("4"))).toBe(false);
    expect(pairs[0].score).toBeGreaterThanOrEqual(pairs[pairs.length - 1].score);
  });
  it("can focus on one node and limit", () => {
    const pairs = findMergePairs(items, { focusId: "2", limit: 1 });
    expect(pairs).toHaveLength(1);
    expect([pairs[0].aId, pairs[0].bId]).toContain("2");
  });
});

describe("rrfFuse", () => {
  it("rewards items ranked well in several lists", () => {
    const L = (...keys: string[]) => keys.map((key) => ({ key, item: key }));
    const out = rrfFuse([L("a", "b", "c"), L("b", "d"), L("b")], 60);
    expect(out[0].key).toBe("b");
    expect(out[0].score).toBeCloseTo(1 / 62 + 1 / 61 + 1 / 61);
    expect(out.map((x) => x.key).sort()).toEqual(["a", "b", "c", "d"]);
    expect(out.find((x) => x.key === "a")!.score).toBeCloseTo(1 / 61);
  });
  it("handles empty input", () => expect(rrfFuse([[], []])).toEqual([]));
});

describe("tsquery building", () => {
  it("makes safe prefix queries", () => {
    expect(toPrefixTsQuery("Søren's  skole!")).toBe("søren:* & s:* & skole:*");
    expect(toPrefixTsQuery("a & b | !c")).toBe("a:* & b:* & c:*");
    expect(toPrefixTsQuery(" ;:() ")).toBeNull();
    expect(toAnyPrefixTsQuery("tandlæge aarhus")).toBe("tandlæge:* | aarhus:*");
  });
  it("vector literal", () => expect(vectorLiteral([1, 0.5, Number.NaN])).toBe("[1,0.5,0]"));
});

describe("fact rules", () => {
  it("noisy-or raises confidence", () => {
    expect(noisyOr(0.5, 0.6)).toBeCloseTo(0.8);
    expect(noisyOr(1, 0.1)).toBe(1);
    expect(noisyOr(0, 0)).toBe(0);
  });
  it("normalises relations", () => {
    expect(normalizeRelation("Parent Of")).toBe("parent_of");
    expect(normalizeRelation("treatedBy")).toBe("treated_by");
    expect(normalizeRelation("--located-at--")).toBe("located_at");
    expect(normalizeRelation("!!!")).toBe("");
    expect(humanizeRelation("parent_of")).toBe("parent of");
  });
  it("narrower visibility wins", () => {
    expect(narrowerVisibility("household", "parents")).toBe("parents");
    expect(narrowerVisibility("private", "household")).toBe("private");
  });
  it("inferred facts are never silently promoted", () => {
    expect(defaultEdgeStatus({ activity: "inference", agentType: "model" })).toBe("inferred");
    expect(defaultEdgeStatus({ activity: "manual_edit", agentType: "user" })).toBe("confirmed");
    expect(defaultEdgeStatus({ activity: "llm_extraction", agentType: "model" })).toBe("unconfirmed");
    expect(statusAfterReassert("inferred", { agentType: "model", status: "confirmed" })).toBe("inferred");
    expect(statusAfterReassert("inferred", { agentType: "user" })).toBe("inferred");
    expect(statusAfterReassert("unconfirmed", { agentType: "user", status: "confirmed" })).toBe("confirmed");
  });
});

describe("isRelevant", () => {
  it("keeps a hit that has every word of the question", () => {
    expect(isRelevant({ kind: "chunk", sim: null, kw: "all" })).toBe(true);
    expect(isRelevant({ kind: "chunk", sim: 0.1, kw: "all" })).toBe(true);
  });
  it("drops an any-word match that the vector doesn't back up (a zoo page for 'swimming')", () => {
    expect(isRelevant({ kind: "chunk", sim: null, kw: "any" })).toBe(false);
    expect(isRelevant({ kind: "chunk", sim: 0.37, kw: "any" })).toBe(false);
    expect(isRelevant({ kind: "chunk", sim: RELEVANCE.anyWordChunk, kw: "any" })).toBe(true);
    expect(isRelevant({ kind: "node", sim: 0.44, kw: "any" })).toBe(true);
  });
  it("needs a close vector match when no word matched", () => {
    expect(isRelevant({ kind: "node", sim: 0.43, kw: null })).toBe(false);
    expect(isRelevant({ kind: "node", sim: 0.52, kw: null })).toBe(true);
    expect(isRelevant({ kind: "chunk", sim: 0.49, kw: null })).toBe(false);
    expect(isRelevant({ kind: "chunk", sim: 0.56, kw: null })).toBe(true);
    expect(isRelevant({ kind: "chunk", sim: null, kw: null })).toBe(false);
  });
});
