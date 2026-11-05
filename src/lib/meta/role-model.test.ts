import { describe, expect, it } from "vitest";
import { BUILTIN_KINDS, BUILTIN_RELATIONS, BUILTIN_ROLES } from "./builtins";
import { attributesFor, findRelation, kindsFor, mergeMetaModel, relationLabel, type KindRow, type RelationRow, type RoleRow } from "./model";
import { planRoleConversion, type ConvEdge, type ConvNode } from "./role-conversion";
import { circleFromRoles, findRole, roleKeyForKind, rolesHeld, roleText, roleWords, visibleRoles } from "./roles";
import type { MetaModel, MetaNodeType } from "./types";

const HH = "hh-1";
let n = 0;
const id = () => `id-${++n}`;

function rows() {
  const kinds: KindRow[] = BUILTIN_KINDS.map((k, i) => ({
    id: id(), householdId: null, nodeType: k.nodeType, key: k.key, label: k.label, pluralLabel: k.pluralLabel ?? null,
    description: k.description ?? null, circle: k.circle ?? null, parentKey: k.parentKey ?? null, icon: null, color: null, sortOrder: i, builtin: true,
  }));
  const relations: RelationRow[] = BUILTIN_RELATIONS.map((r) => ({
    id: id(), householdId: null, key: r.key, label: r.label, inverseLabel: r.inverseLabel, category: r.category,
    fromTypes: r.fromTypes, toTypes: r.toTypes, symmetric: !!r.symmetric, builtin: true,
  }));
  const roles: RoleRow[] = BUILTIN_ROLES.map((r, i) => ({
    id: id(), householdId: null, key: r.key, label: r.label, pluralLabel: r.pluralLabel, preposition: r.preposition, inverseLabel: r.inverseLabel ?? null,
    labelDa: r.da.label, pluralLabelDa: r.da.plural, prepositionDa: r.da.preposition, inverseLabelDa: r.da.inverse ?? null, description: r.description ?? null,
    contextTypes: r.contexts ?? [], circle: r.circle, impliedBy: r.impliedBy ?? null, parentKey: r.parentKey ?? null, icon: null, sortOrder: i, builtin: true,
  }));
  return { kinds, relations, attributes: [], roles };
}

const model = (extra: Partial<ReturnType<typeof rows>> = {}): MetaModel => mergeMetaModel(HH, { ...rows(), ...extra });

describe("roles in the meta model", () => {
  it("reads built-in roles, and hides person kinds that became roles from pickers (they still label old data)", () => {
    const m = model();
    expect(visibleRoles(m).map((r) => r.key)).toEqual(expect.arrayContaining(["doctor", "teacher", "class_teacher", "client", "landlord", "colleague"]));
    const pick = kindsFor(m, "person").map((k) => k.key);
    expect(pick).toEqual(expect.arrayContaining(["child", "partner", "other"]));
    expect(pick).not.toContain("doctor");
    expect(pick).not.toContain("colleague");
    const doctorKind = m.kinds.find((k) => k.nodeType === "person" && k.key === "doctor");
    expect(doctorKind?.hidden).toBe(true);
    expect(doctorKind?.circle).toBe("care");
  });

  it("keeps household role rows per graph and candidates apart", () => {
    const own: RoleRow = { ...rows().roles[0], id: id(), householdId: HH, key: "football_coach", label: "Football coach", labelDa: "Fodboldtræner", graphId: "g1", status: "candidate", builtin: false, impliedBy: null };
    const other: RoleRow = { ...own, id: id(), key: "shop_steward", label: "Shop steward", graphId: "g2", status: "active" };
    const m = mergeMetaModel(HH, { ...rows(), roles: [...rows().roles, own, other] }, { graphId: "g1" });
    expect(m.candidates?.roles?.map((r) => r.key)).toEqual(["football_coach"]);
    expect(m.roles?.some((r) => r.key === "shop_steward")).toBe(false);
  });

  it("words roles in English and Danish, with a person context reading 'of' / 'for'", () => {
    const m = model();
    const doctor = findRole(m, "doctor");
    expect(roleText(doctor, "doctor", { label: "Lægehuset Vejle", type: "organization" }, "en")).toBe("Doctor at Lægehuset Vejle");
    expect(roleText(doctor, "doctor", { label: "Lægehuset Vejle", type: "organization" }, "da")).toBe("Læge på Lægehuset Vejle");
    expect(roleText(doctor, "doctor", { label: "Emma", type: "person" }, "en")).toBe("Doctor of Emma");
    expect(roleText(doctor, "doctor", { label: "Emma", type: "person" }, "da")).toBe("Læge for Emma");
    expect(roleText(findRole(m, "class_teacher"), "class_teacher", { label: "3.B", type: "organization" }, "en")).toBe("Class teacher of 3.B");
    expect(roleText(doctor, "doctor", null, "da")).toBe("Læge");
    expect(roleWords(undefined, "en", "football_coach").label).toBe("Football coach");
  });

  it("reads a role edge as a relation so every fact label still works", () => {
    const m = model();
    expect(relationLabel(m, "role:doctor")).toBe("doctor at");
    expect(relationLabel(m, "role:doctor", "in")).toBe("has as doctor");
    expect(findRelation(m, "role:teacher")?.category).toBe("school");
    expect(findRelation(m, "role:unknown_thing")?.category).toBe("other");
  });

  it("gives role holders the details their old kind carried", () => {
    const m = mergeMetaModel(HH, { ...rows(), attributes: [
      { id: id(), householdId: null, nodeType: "person" as MetaNodeType, kindKey: "doctor", key: "clinic", label: "Clinic", dataType: "text", options: [], required: false, sensitive: false, sortOrder: 1, builtin: true },
    ] });
    expect(attributesFor(m, "person", null).some((a) => a.key === "clinic")).toBe(false);
    expect(attributesFor(m, "person", null, ["doctor"]).some((a) => a.key === "clinic")).toBe(true);
  });

  it("only turns kinds that name roles into roles (child, partner and clinical records stay)", () => {
    const keys = new Set(BUILTIN_ROLES.map((r) => r.key));
    expect(roleKeyForKind("doctor", keys)).toBe("doctor");
    expect(roleKeyForKind("child", keys)).toBeNull();
    expect(roleKeyForKind("partner", keys)).toBeNull();
    expect(roleKeyForKind("client", keys)).toBeNull();
    expect(roleKeyForKind("patient", keys)).toBeNull();
    expect(roleKeyForKind("football_fan", keys)).toBeNull();
  });
});

describe("roles a person holds, and their circle", () => {
  const m = model();
  const nodes = new Map([
    ["lars", { id: "lars", label: "Lars", type: "person" }], ["clinic", { id: "clinic", label: "Lægehuset Vejle", type: "organization" }],
    ["emma", { id: "emma", label: "Emma", type: "person" }], ["anna", { id: "anna", label: "Anna", type: "person" }],
    ["flat", { id: "flat", label: "Our flat", type: "place" }],
  ]);

  it("lists role edges, roles a relation implies, past roles last, and drops contexts the viewer can't see", () => {
    const held = rolesHeld(m, "lars", [
      { id: "e1", fromId: "lars", toId: "clinic", relation: "role:doctor", status: "confirmed", validFrom: "2021-03-01T00:00:00Z" },
      { id: "e2", fromId: "lars", toId: "emma", relation: "parent_of", status: "confirmed" },
      { id: "e3", fromId: "lars", toId: "flat", relation: "role:landlord", status: "confirmed", validTo: "2023-06-01T00:00:00Z" },
      { id: "e4", fromId: "lars", toId: "hidden-place", relation: "role:coach", status: "confirmed" },
      { id: "e5", fromId: "lars", toId: "lars", relation: "role:neighbour", status: "unconfirmed" },
      { id: "e6", fromId: "lars", toId: "clinic", relation: "role:nurse", status: "rejected" },
    ], nodes, new Date("2026-01-01T00:00:00Z"));
    expect(held.map((h) => `${h.key}:${h.context?.label ?? "-"}:${h.current}`)).toEqual([
      "doctor:Lægehuset Vejle:true", "neighbour:-:true", "parent:Emma:true", "landlord:Our flat:false",
    ]);
    expect(held[0].from).toBe("2021-03-01T00:00:00.000Z");
    expect(held.find((h) => h.key === "parent")?.implied).toBe(true);
  });

  it("reads the child side of parent_of as the child role", () => {
    const held = rolesHeld(m, "emma", [{ id: "e2", fromId: "lars", toId: "emma", relation: "parent_of", status: "confirmed" }], nodes);
    expect(held.map((h) => h.key)).toEqual(["child"]);
  });

  it("puts someone in the closest circle any current role implies", () => {
    expect(circleFromRoles(m, [{ key: "doctor", current: true }])).toBe("care");
    expect(circleFromRoles(m, [{ key: "colleague", current: true }, { key: "close_friend", current: true }])).toBe("close");
    expect(circleFromRoles(m, [{ key: "teacher", current: false }])).toBeNull();
    expect(circleFromRoles(m, [])).toBeNull();
    // A Work graph maps roles to its own circles.
    expect(circleFromRoles(m, [{ key: "colleague", current: true }], (r) => (r.key === "colleague" ? "team" : r.circle))).toBe("team");
  });
});

describe("planning the conversion of kinds into roles", () => {
  const keys = new Set(BUILTIN_ROLES.map((r) => r.key));
  const implied = new Map(BUILTIN_ROLES.filter((r) => r.impliedBy).map((r) => [r.key, r.impliedBy!]));
  const person = (id: string, label: string, kind: string | null, props: Record<string, unknown> = {}): ConvNode => ({ id, type: "person", label, kind, props });
  const e = (id: string, fromId: string, relation: string, toId: string, status = "confirmed"): ConvEdge => ({ id, fromId, toId, relation, status });

  it("proposes a role with the context the graph knows, a role without one, and clears the kind", () => {
    const plan = planRoleConversion({
      nodes: [person("anna", "Anna", null, { self: true }), person("mette", "Dr. Mette Lund", "doctor"), person("karen", "Karen Hansen", "teacher"),
        person("emma", "Emma", "child"), person("jonas", "Jonas Berg", "doctor"), { id: "clinic", type: "organization", kind: null, label: "Lægehuset" }],
      edges: [e("1", "anna", "treated_by", "mette"), e("2", "karen", "teacher_of", "emma"), e("3", "jonas", "member_of", "clinic")],
      roleKeys: keys, impliedBy: implied,
    });
    const adds = plan.changes.filter((c) => c.op === "addEdge") as { fromId: string; toId: string; relation: string }[];
    expect(adds).toEqual(expect.arrayContaining([
      expect.objectContaining({ fromId: "mette", toId: "anna", relation: "role:doctor" }),
      expect.objectContaining({ fromId: "karen", toId: "emma", relation: "role:teacher" }),
      expect.objectContaining({ fromId: "jonas", toId: "clinic", relation: "role:doctor" }),
    ]));
    const clears = plan.changes.filter((c) => c.op === "updateNode").map((c) => (c as { nodeId: string }).nodeId);
    expect(clears.sort()).toEqual(["jonas", "karen", "mette"]);
    expect(plan.changes.some((c) => c.op === "updateNode" && (c as { nodeId: string }).nodeId === "emma")).toBe(false);
    expect(plan.counts).toMatchObject({ people: 3, roles: 3, withContext: 3 });
  });

  it("falls back to the role without a context (pointing at the person), and skips roles a relation already says", () => {
    const plan = planRoleConversion({
      nodes: [person("sofie", "Sofie Lund", "close_friend"), person("birgit", "Birgit Jensen", "grandparent"), person("emma", "Emma", "child")],
      edges: [e("1", "birgit", "grandparent_of", "emma")],
      roleKeys: keys, impliedBy: implied,
    });
    expect(plan.changes).toEqual(expect.arrayContaining([expect.objectContaining({ op: "addEdge", fromId: "sofie", toId: "sofie", relation: "role:close_friend" })]));
    expect(plan.changes.some((c) => c.op === "addEdge" && (c as { fromId: string }).fromId === "birgit")).toBe(false);
    expect(plan.changes).toEqual(expect.arrayContaining([expect.objectContaining({ op: "updateNode", nodeId: "birgit", set: { kind: null } })]));
    expect(plan.counts.implied).toBe(1);
  });

  it("merges a role-only entry into the one person holding that role, else retires it; members are never touched", () => {
    const plan = planRoleConversion({
      nodes: [person("t", "the teacher", null), person("karen", "Karen Hansen", "teacher"), person("s2", "Speaker 2", null),
        person("laegen", "Lægen", null), person("m1", "Dr. Mette", "doctor"), person("m2", "Jonas", "doctor"), person("me", "Speaker 1", null, { self: true })],
      edges: [], roleKeys: keys, impliedBy: implied,
    });
    expect(plan.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ op: "mergeNodes", keepId: "karen", dropId: "t" }),
      expect.objectContaining({ op: "retireNode", nodeId: "s2" }),
      expect.objectContaining({ op: "retireNode", nodeId: "laegen" }), // two doctors: not known which one
    ]));
    expect(plan.changes.some((c) => (c as { nodeId?: string }).nodeId === "me" || (c as { dropId?: string }).dropId === "me")).toBe(false);
    expect(plan.counts).toMatchObject({ merged: 1, retired: 2 });
  });

  it("leaves people the viewer can't change, and proposes nothing twice", () => {
    const base = { nodes: [person("mette", "Dr. Mette Lund", "doctor"), person("x", "Private doctor", "doctor")], roleKeys: keys, impliedBy: implied };
    const plan = planRoleConversion({ ...base, edges: [e("1", "mette", "role:doctor", "mette")], editable: (id) => id !== "x" });
    expect(plan.changes.filter((c) => c.op === "addEdge")).toHaveLength(0);
    expect(plan.changes).toEqual([expect.objectContaining({ op: "updateNode", nodeId: "mette" })]);
  });
});

describe("conversion contexts", () => {
  it("never takes an event or a document as the place a role is held", () => {
    const keys = new Set(BUILTIN_ROLES.map((r) => r.key));
    const plan = planRoleConversion({
      nodes: [{ id: "m", type: "person", kind: "doctor", label: "Dr. Mette Lund" }, { id: "ev", type: "event", kind: null, label: "Dentist appointment" }],
      edges: [{ id: "1", fromId: "ev", toId: "m", relation: "treated_by", status: "confirmed" }], roleKeys: keys, impliedBy: new Map(),
    });
    expect(plan.changes).toEqual(expect.arrayContaining([expect.objectContaining({ op: "addEdge", fromId: "m", toId: "m", relation: "role:doctor" })]));
  });
});
