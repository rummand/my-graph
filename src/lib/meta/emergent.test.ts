import { describe, expect, it } from "vitest";
import { BUILTIN_KINDS, BUILTIN_RELATIONS } from "./builtins";
import { isPossessive, opsFromPlan, planFromExtraction, planSummary, extractionSchema, guessInverse } from "./domain";
import { mergeMetaModel, type KindRow, type RelationRow } from "./model";
import { findSynonymKind, findSynonymRelation, normalizeTerm, sameTerm, synonymPairs, toKey } from "./synonyms";
import { getTemplate, keepsBuiltin, missingFromTemplate, TEMPLATES } from "@/lib/templates/templates";
import type { MetaModel, MetaNodeType } from "./types";

const HH = "hh-1";
let n = 0;
const id = () => `id-${++n}`;

function rows() {
  const kinds: KindRow[] = BUILTIN_KINDS.map((k, i) => ({
    id: id(), householdId: null, nodeType: k.nodeType, key: k.key, label: k.label, pluralLabel: k.pluralLabel ?? null,
    description: null, circle: k.circle ?? null, parentKey: null, icon: null, color: null, sortOrder: i, builtin: true,
  }));
  const relations: RelationRow[] = BUILTIN_RELATIONS.map((r) => ({
    id: id(), householdId: null, key: r.key, label: r.label, inverseLabel: r.inverseLabel, category: r.category,
    fromTypes: r.fromTypes, toTypes: r.toTypes, symmetric: !!r.symmetric, builtin: true,
  }));
  return { kinds, relations, attributes: [] };
}

/** The household model as a Work graph sees it, with the work template's own rows seeded for graph g1. */
function workModel(graphId = "g1"): MetaModel {
  const t = getTemplate("work");
  const r = rows();
  for (const k of t.kinds) r.kinds.push({ id: id(), householdId: HH, nodeType: k.nodeType, key: k.key, label: k.label, pluralLabel: k.pluralLabel ?? null, description: null, circle: k.circle ?? null, parentKey: null, icon: null, color: null, sortOrder: 3000, builtin: false, source: "template", graphId, status: "active" });
  for (const x of t.relations) r.relations.push({ id: id(), householdId: HH, key: x.key, label: x.label, inverseLabel: x.inverseLabel, category: x.category, fromTypes: x.fromTypes, toTypes: x.toTypes, symmetric: !!x.symmetric, builtin: false, source: "template", graphId, status: "active" });
  return mergeMetaModel(HH, r, { graphId, keepBuiltin: (table, row) => keepsBuiltin(t, table, row), circleOf: (k) => t.circleOf[k.key] });
}

describe("synonyms", () => {
  it("normalises plurals, Danish letters and articles", () => {
    expect(normalizeTerm("The Departments")).toBe("department");
    expect(normalizeTerm("Afdelinger")).toBe("afdelinger");
    expect(normalizeTerm("works_on")).toBe("work on");
    expect(toKey("Architecture Enablement")).toBe("architecture_enablement");
    expect(toKey("Børnehave")).toBe("boernehave");
  });

  it("finds the same thing under another name", () => {
    expect(sameTerm("Dept", "Department")).toBe("synonym");
    expect(sameTerm("Customer", "Client")).toBe("synonym");
    expect(sameTerm("Departmnet", "Department")).toBe("spelling");
    expect(sameTerm("Teams", "team")).toBe("same");
    expect(sameTerm("Project", "Department")).toBeNull();
  });

  it("maps a kind label to an existing kind, preferring the given type", () => {
    const m = workModel();
    expect(findSynonymKind(m, "customer", "organization")?.kind.key).toBe("client");
    expect(findSynonymKind(m, "Department", "organization")).toBeNull();
  });

  it("maps relation phrasing both ways", () => {
    const m = workModel();
    expect(findSynonymRelation(m, "working on")?.relation.key).toBe("works_on");
    const back = findSynonymRelation(m, "worked on by");
    expect(back?.relation.key).toBe("works_on");
    expect(back?.direction).toBe("in");
    expect(findSynonymRelation(m, "is part of")?.relation.key).toBe("belongs_to");
    expect(findSynonymRelation(m, "sponsors")).toBeNull();
  });

  it("pairs candidate synonyms for merge suggestions", () => {
    expect(synonymPairs([{ id: "a", label: "Dept" }, { id: "b", label: "Department" }, { id: "c", label: "Risk" }])).toEqual([{ a: "a", b: "b", reason: "synonym" }]);
  });
});

describe("templates", () => {
  it("has a template for every graph kind and falls back to the generic one", () => {
    for (const k of ["family", "personal", "work", "partner", "project", "shared", "other"]) expect(getTemplate(k).kind).toBe(k);
    expect(getTemplate("nonsense").kind).toBe("other");
  });

  it("keeps all built-ins in a family graph but hides family kinds in a work graph", () => {
    expect(keepsBuiltin(TEMPLATES.family, "kinds", { nodeType: "person", key: "pedagogue" })).toBe(true);
    const m = workModel();
    const pedagogue = m.kinds.find((k) => k.key === "pedagogue")!;
    expect(pedagogue.hidden && pedagogue.offTemplate).toBe(true);
    expect(m.kinds.find((k) => k.key === "colleague")!.hidden).toBe(false);
    expect(m.kinds.find((k) => k.key === "colleague")!.circle).toBe("team");
    expect(m.relations.find((r) => r.key === "parent_of")!.hidden).toBe(true);
    expect(m.relations.find((r) => r.key === "works_on")!.hidden).toBe(false);
  });

  it("shows a graph's own rows only in that graph", () => {
    const other = workModel("g2");
    const r = rows();
    r.kinds.push({ id: id(), householdId: HH, nodeType: "organization", key: "department", label: "Department", pluralLabel: null, description: null, circle: null, parentKey: null, icon: null, color: null, sortOrder: 1, builtin: false, graphId: "g2", source: "emergent", status: "active" });
    expect(mergeMetaModel(HH, r, { graphId: "g1" }).kinds.some((k) => k.key === "department")).toBe(false);
    expect(mergeMetaModel(HH, r, { graphId: "g2" }).kinds.some((k) => k.key === "department")).toBe(true);
    expect(other.kinds.some((k) => k.key === "team")).toBe(true);
  });

  it("keeps candidates out of the model and returns them separately", () => {
    const r = rows();
    r.kinds.push({ id: id(), householdId: HH, nodeType: "organization", key: "guild", label: "Guild", pluralLabel: null, description: null, circle: null, parentKey: null, icon: null, color: null, sortOrder: 1, builtin: false, graphId: "g1", source: "emergent", status: "candidate", evidenceCount: 3 });
    const m = mergeMetaModel(HH, r, { graphId: "g1" });
    expect(m.kinds.some((k) => k.key === "guild")).toBe(false);
    expect(m.candidates?.kinds.map((k) => [k.key, k.evidenceCount])).toEqual([["guild", 3]]);
  });

  it("seeds only what is missing", () => {
    const t = TEMPLATES.work;
    const miss = missingFromTemplate(t, { kinds: [{ nodeType: "organization", key: "team" }], relations: [{ key: "works_on" }], attributes: [] });
    expect(miss.kinds.some((k) => k.key === "team")).toBe(false);
    expect(miss.kinds.some((k) => k.key === "client")).toBe(true);
    expect(miss.relations.some((r) => r.key === "works_on")).toBe(false);
  });
});

describe("domain model from a description", () => {
  const text = "Im working on a project for my department Architecture Enablement, the project is called EAM Platform";
  const extraction = extractionSchema.parse({
    entities: [
      { ref: "e1", label: "Architecture Enablement", surface: "Architecture Enablement", type: "organization", kind: "Department" },
      { ref: "e2", label: "EAM Platform", surface: "EAM Platform", type: "project", kind: "Project" },
    ],
    facts: [
      { from: "you", relation: "works on", to: "e2" },
      { from: "e2", relation: "belongs to", to: "e1" },
      { from: "you", relation: "member of", to: "e1" },
    ],
  });

  it("proposes the new kinds Department and Project and reuses the work relations", () => {
    const plan = planFromExtraction(workModel(), extraction, [], { id: "self-1", label: "Sara" });
    expect(plan.kinds.filter((k) => k.isNew).map((k) => [k.nodeType, k.key, k.label])).toEqual([["organization", "department", "Department"], ["project", "project", "Project"]]);
    expect(plan.facts.map((f) => [f.from, f.relationKey, f.to, f.newRelation])).toEqual([
      ["you", "works_on", "e2", false], ["e2", "belongs_to", "e1", false], ["you", "member_of", "e1", false],
    ]);
    expect(planSummary(plan)).toMatchObject({ things: 2, facts: 3, newKinds: 2, newRelations: 0 });
    void text;
  });

  it("adds you as a member of an organisation the text calls yours", () => {
    const x = extractionSchema.parse({ ...extraction, facts: extraction.facts.slice(0, 2) });
    const plan = planFromExtraction(workModel(), x, [], { id: "self-1", label: "Sara" }, { text });
    expect(plan.facts.map((f) => [f.from, f.relationKey, f.to])).toContainEqual(["you", "member_of", "e1"]);
    expect(isPossessive("min afdeling Arkitektur", "Arkitektur")).toBe(true);
    expect(isPossessive("their department Arkitektur", "Arkitektur")).toBe(false);
    const only = extractionSchema.parse({ ...extraction, facts: [] });
    const p2 = planFromExtraction(workModel(), only, [], { id: "self-1", label: "Sara" }, { text });
    expect(p2.facts.map((f) => [f.from, f.relationKey, f.to])).toEqual([["you", "member_of", "e1"], ["e2", "belongs_to", "e1"]]);
  });

  it("turns the plan into ops: kinds first, nodes with minted ids, then facts to you", () => {
    const plan = planFromExtraction(workModel(), extraction, [], { id: "self-1", label: "Sara" });
    let i = 0;
    const { ops, nodeIds } = opsFromPlan(plan, { selfId: "self-1", mint: () => `new-${++i}`, receipt: (q) => ({ quote: q }) });
    expect(ops.map((o) => o.op)).toEqual(["addKind", "addKind", "addNode", "addNode", "addEdge", "addEdge", "addEdge"]);
    expect(ops[2]).toMatchObject({ op: "addNode", type: "organization", kind: "department", label: "Architecture Enablement", nodeId: "new-1" });
    expect(ops[4]).toMatchObject({ op: "addEdge", fromId: "self-1", toId: nodeIds.e2, relation: "works_on" });
    expect(ops.every((o) => o.receipt)).toBe(true);
  });

  it("links existing things instead of duplicating them, and reuses a kind the second time", () => {
    const m = workModel();
    m.kinds.push({ ...m.kinds.find((k) => k.key === "team")!, id: "dep", key: "department", label: "Department", nodeType: "organization" as MetaNodeType });
    const plan = planFromExtraction(m, extraction, [{ id: "n-ae", label: "Architecture Enablement", type: "organization", kind: "department" }], { id: "self-1", label: "Sara" });
    expect(plan.entities.find((e) => e.ref === "e1")).toMatchObject({ existing: true, nodeId: "n-ae" });
    expect(plan.kinds.filter((k) => k.isNew).map((k) => k.key)).toEqual(["project"]);
  });

  it("drops facts about you when there is no self node, and proposes new relations with an inverse", () => {
    const x = extractionSchema.parse({ entities: [{ ref: "a", label: "Acme", type: "organization", kind: "Company" }, { ref: "b", label: "Gala", type: "event" }], facts: [{ from: "you", relation: "works on", to: "a" }, { from: "a", relation: "sponsors", to: "b" }] });
    const plan = planFromExtraction(workModel(), x, [], { id: null, label: "Sara" });
    expect(plan.facts.map((f) => f.relationKey)).toEqual(["sponsors"]);
    expect(plan.relations[0]).toMatchObject({ key: "sponsors", isNew: true, inverseLabel: "sponsored by" });
    expect(plan.entities[0].kindKey).toBe("company");
    expect(guessInverse("works on")).toBe("worked on by");
  });
});

describe("the writer's own words for kinds", () => {
  it("reads the kind word before a name", async () => {
    const { kindWordNear, cleanSurface } = await import("./domain");
    const t = "Im working on a project for my department Architecture Enablement, the project is called EAM Platform";
    expect(kindWordNear(t, "Architecture Enablement")).toBe("department");
    expect(kindWordNear(t, "EAM Platform")).toBe("project");
    expect(kindWordNear("I met Emma at the café", "Emma")).toBeNull();
    expect(cleanSurface("my department Architecture Enablement", "Architecture Enablement")).toBe("Architecture Enablement");
    const { trimKindWord } = await import("./domain");
    expect(trimKindWord("Data Mesh project", "Data Mesh project", "Project")).toEqual({ label: "Data Mesh", surface: "Data Mesh" });
    expect(trimKindWord("EAM Platform", "EAM Platform", "System")).toEqual({ label: "EAM Platform", surface: "EAM Platform" });
    expect(extractionSchema.parse({ entities: [{ ref: "a", label: "X", type: "organization", kind: "Organization/Team" }] }).entities[0].kind).toBe("Team");
  });

  it("prefers the writer's word over an existing kind the model picked", () => {
    const t = "Im working on a project for my department Architecture Enablement, the project is called EAM Platform";
    const x = extractionSchema.parse({ entities: [{ ref: "e1", label: "Architecture Enablement", surface: "my department Architecture Enablement", type: "organization", kind: "Team" }], facts: [] });
    const plan = planFromExtraction(workModel(), x, [], { id: "self-1", label: "Sara" }, { text: t });
    expect(plan.entities[0]).toMatchObject({ kindKey: "department", newKind: true, surface: "Architecture Enablement" });
  });
});
