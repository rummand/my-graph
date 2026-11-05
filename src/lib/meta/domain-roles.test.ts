import { describe, expect, it } from "vitest";
import { BUILTIN_KINDS, BUILTIN_ROLES } from "./builtins";
import { extractionSchema, opsFromPlan, planFromExtraction } from "./domain";
import { mergeMetaModel, type KindRow, type RoleRow } from "./model";

let n = 0;
const id = () => `id-${++n}`;

function model() {
  const kinds: KindRow[] = BUILTIN_KINDS.map((k, i) => ({
    id: id(), householdId: null, nodeType: k.nodeType, key: k.key, label: k.label, pluralLabel: k.pluralLabel ?? null,
    description: null, circle: k.circle ?? null, parentKey: null, icon: null, color: null, sortOrder: i, builtin: true,
  }));
  const roles: RoleRow[] = BUILTIN_ROLES.map((r, i) => ({
    id: id(), householdId: null, key: r.key, label: r.label, pluralLabel: r.pluralLabel, preposition: r.preposition, inverseLabel: r.inverseLabel ?? null,
    labelDa: r.da.label, pluralLabelDa: r.da.plural, prepositionDa: r.da.preposition, inverseLabelDa: r.da.inverse ?? null, description: null,
    contextTypes: r.contexts ?? [], circle: r.circle, impliedBy: r.impliedBy ?? null, parentKey: r.parentKey ?? null, icon: null, sortOrder: i, builtin: true,
  }));
  return mergeMetaModel("hh", { kinds, relations: [], attributes: [], roles }, { graphId: "g1" });
}

describe("describing your world: a person's role is a role, not a kind", () => {
  const x = extractionSchema.parse({
    entities: [
      { ref: "e1", label: "Karen", type: "person", kind: "Teacher" },
      { ref: "e2", label: "Ny Skole", type: "place", kind: "School" },
      { ref: "e3", label: "Ole", type: "person", kind: "Groundskeeper" },
      { ref: "e4", label: "Emma", type: "person", kind: "Child" },
    ],
    facts: [{ from: "e1", relation: "located at", to: "e2" }],
  });

  it("uses a known role, proposes a new one for an unknown word, keeps person kinds that stay kinds", () => {
    const plan = planFromExtraction(model(), x, [], { id: "self", label: "Anna" });
    const by = (ref: string) => plan.entities.find((e) => e.ref === ref)!;
    expect(by("e1")).toMatchObject({ kindKey: null, roleKey: "teacher" });
    expect(by("e3")).toMatchObject({ kindKey: null, roleKey: "groundskeeper" });
    expect(by("e4")).toMatchObject({ kindKey: "child" });
    expect(plan.roles?.map((r) => [r.key, r.isNew])).toEqual([["teacher", false], ["groundskeeper", true]]);
    expect(plan.kinds.some((k) => k.nodeType === "person" && k.isNew)).toBe(false);

    let m = 0;
    const { ops, nodeIds } = opsFromPlan(plan, { selfId: "self", mint: () => `n${++m}`, receipt: (q) => ({ quote: q }) });
    expect(ops.filter((o) => o.op === "addRole").map((o) => o.key)).toEqual(["groundskeeper"]);
    expect(ops.some((o) => o.op === "addKind" && o.nodeType === "person")).toBe(false);
    const roleEdges = ops.filter((o) => o.op === "addEdge" && String(o.relation).startsWith("role:")).map((o) => [o.fromId, o.relation, o.toId]);
    expect(roleEdges).toEqual([[nodeIds.e1, "role:teacher", nodeIds.e2], [nodeIds.e3, "role:groundskeeper", nodeIds.e3]]);
    // The new role comes before the edge that uses it.
    expect(ops.findIndex((o) => o.op === "addRole")).toBeLessThan(ops.findIndex((o) => o.relation === "role:groundskeeper"));
  });
});
