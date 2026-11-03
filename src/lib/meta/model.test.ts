import { describe, expect, it } from "vitest";
import { BUILTIN_ATTRIBUTES, BUILTIN_KINDS, BUILTIN_RELATIONS } from "./builtins";
import { attributesFor, kindsFor, mergeMetaModel, relationLabel, suggestKind, validateProps, type AttributeRow, type KindRow, type RelationRow } from "./model";
import type { MetaNodeType } from "./types";

const HH = "hh-1";
let n = 0;
const id = () => `id-${++n}`;

function builtinRows() {
  const kinds: KindRow[] = BUILTIN_KINDS.map((k, i) => ({
    id: id(), householdId: null, nodeType: k.nodeType, key: k.key, label: k.label, pluralLabel: k.pluralLabel ?? null,
    description: k.description ?? null, circle: k.circle ?? null, parentKey: k.parentKey ?? null, icon: null, color: null, sortOrder: i, builtin: true,
  }));
  const relations: RelationRow[] = BUILTIN_RELATIONS.map((r) => ({
    id: id(), householdId: null, key: r.key, label: r.label, inverseLabel: r.inverseLabel, category: r.category,
    fromTypes: r.fromTypes, toTypes: r.toTypes, symmetric: !!r.symmetric, builtin: true,
  }));
  const attributes: AttributeRow[] = BUILTIN_ATTRIBUTES.map((a, i) => ({
    id: id(), householdId: null, nodeType: a.nodeType, kindKey: a.kindKey ?? null, key: a.key, label: a.label, dataType: a.dataType,
    options: a.options ?? [], required: !!a.required, sensitive: !!a.sensitive, sortOrder: i, builtin: true,
  }));
  return { kinds, relations, attributes };
}

const kindRow = (p: Partial<KindRow> & { key: string }): KindRow => ({
  id: id(), householdId: HH, nodeType: "person" as MetaNodeType, label: p.key, pluralLabel: null, description: null, circle: null,
  parentKey: null, icon: null, color: null, sortOrder: 9000, builtin: false, ...p,
});

describe("mergeMetaModel", () => {
  it("returns built-ins untouched when the household has no rows", () => {
    const m = mergeMetaModel(HH, builtinRows());
    expect(kindsFor(m, "person").map((k) => k.key)).toContain("health_visitor");
    expect(m.kinds.every((k) => k.origin === "builtin" && !k.hidden)).toBe(true);
  });

  it("lets a household row with the same key win, and adds new ones", () => {
    const rows = builtinRows();
    rows.kinds.push(kindRow({ key: "teacher", label: "Lærer", circle: "school" }), kindRow({ key: "football_coach", label: "Football coach", circle: "social" }));
    const m = mergeMetaModel(HH, rows);
    const teacher = m.kinds.filter((k) => k.key === "teacher" && k.nodeType === "person");
    expect(teacher).toHaveLength(1);
    expect(teacher[0]).toMatchObject({ label: "Lærer", origin: "override", builtin: true });
    expect(m.kinds.find((k) => k.key === "football_coach")).toMatchObject({ origin: "household", builtin: false });
  });

  it("ignores other households' rows", () => {
    const rows = builtinRows();
    rows.kinds.push(kindRow({ key: "teacher", label: "Not ours", householdId: "hh-2" }));
    expect(mergeMetaModel(HH, rows).kinds.find((k) => k.key === "teacher")!.label).toBe("Teacher");
  });

  it("hides a built-in with a tombstone but keeps it for labelling", () => {
    const rows = builtinRows();
    rows.kinds.push(kindRow({ key: "manager", builtin: true }));
    rows.relations.push({ ...rows.relations.find((r) => r.key === "coaches")!, id: id(), householdId: HH, builtin: true });
    const m = mergeMetaModel(HH, rows);
    expect(kindsFor(m, "person").map((k) => k.key)).not.toContain("manager");
    expect(m.kinds.find((k) => k.key === "manager")).toMatchObject({ hidden: true, label: "Manager" });
    expect(relationLabel(m, "coaches", "in")).toBe("coached by");
  });

  it("overrides attributes per kind", () => {
    const rows = builtinRows();
    rows.attributes.push({ ...rows.attributes.find((a) => a.key === "notes" && a.kindKey === null)!, id: id(), householdId: HH, label: "Noter", builtin: false });
    const m = mergeMetaModel(HH, rows);
    expect(attributesFor(m, "person", null).find((a) => a.key === "notes")).toMatchObject({ label: "Noter", origin: "override" });
  });
});

describe("relations and attributes", () => {
  const m = mergeMetaModel(HH, builtinRows());
  it("labels relations in both directions", () => {
    expect(relationLabel(m, "parent_of", "out")).toBe("parent of");
    expect(relationLabel(m, "parent_of", "in")).toBe("child of");
    expect(relationLabel(m, "friend_of", "in")).toBe("friend of");
    expect(relationLabel(m, "made_up_thing", "out")).toBe("made up thing");
  });
  it("gives a child the child attributes after the person ones", () => {
    const keys = attributesFor(m, "person", "child").map((a) => a.key);
    expect(keys.slice(0, 3)).toEqual(["birthday", "phone", "email"]);
    expect(keys).toEqual(expect.arrayContaining(["school", "class", "shoe_size", "interests"]));
    expect(attributesFor(m, "person", "friend").map((a) => a.key)).not.toContain("shoe_size");
  });
  it("inherits attributes through parentKey", () => {
    const rows = builtinRows();
    rows.kinds.push(kindRow({ key: "school_dentist", parentKey: "dentist" }));
    const m2 = mergeMetaModel(HH, rows);
    expect(attributesFor(m2, "person", "school_dentist").map((a) => a.key)).toContain("practice_number");
  });
});

describe("validateProps", () => {
  const m = mergeMetaModel(HH, builtinRows());
  it("accepts and normalises good values, keeps unknown keys", () => {
    const r = validateProps(m, "person", "babysitter", { birthday: "2015-02-28", phone: "+45 12 34 56 78", email: " a@b.dk ", rate: "120,5", extra: 1 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toMatchObject({ email: "a@b.dk", rate: 120.5, extra: 1 });
  });
  it("accepts a birthday without a year", () => {
    expect(validateProps(m, "person", null, { birthday: "--02-29" }).ok).toBe(true);
  });
  it("returns typed errors", () => {
    const r = validateProps(m, "person", null, { birthday: "2015-02-30", email: "nope", phone: "call me" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.map((e) => e.key).sort()).toEqual(["birthday", "email", "phone"]);
      expect(r.errors.every((e) => e.code === "invalid_value")).toBe(true);
    }
  });
  it("turns empty strings into null (removal)", () => {
    const r = validateProps(m, "person", null, { notes: "  " });
    expect(r.ok && r.value.notes).toBe(null);
  });
  it("enforces required attributes, but not for absent keys in partial mode", () => {
    const rows = builtinRows();
    rows.attributes.push({ id: id(), householdId: HH, nodeType: "person", kindKey: null, key: "nickname", label: "Nickname", dataType: "text", options: [], required: true, sensitive: false, sortOrder: 1, builtin: false });
    const m2 = mergeMetaModel(HH, rows);
    const r = validateProps(m2, "person", null, {});
    expect(!r.ok && r.errors[0]).toMatchObject({ key: "nickname", code: "required" });
    expect(validateProps(m2, "person", null, {}, { partial: true }).ok).toBe(true);
  });
  it("checks enum options and long text", () => {
    const rows = builtinRows();
    rows.attributes.push({ id: id(), householdId: HH, nodeType: "person", kindKey: null, key: "hand", label: "Hand", dataType: "enum", options: ["left", "right"], required: false, sensitive: false, sortOrder: 1, builtin: false });
    const m2 = mergeMetaModel(HH, rows);
    expect(validateProps(m2, "person", null, { hand: "left" }).ok).toBe(true);
    expect(validateProps(m2, "person", null, { hand: "both" }).ok).toBe(false);
    const long = validateProps(m2, "person", null, { how_we_know: "x".repeat(600) });
    expect(!long.ok && long.errors[0].code).toBe("too_long");
  });
});

describe("suggestKind", () => {
  const m = mergeMetaModel(HH, builtinRows());
  it("recognises Danish and English cues", () => {
    expect(suggestKind("Sundhedsplejerske Lone", {}, m)?.kind).toBe("health_visitor");
    expect(suggestKind("Tandlæge Hansen", {}, m)?.kind).toBe("dentist");
    expect(suggestKind("Dr. Jensen", {}, m)?.kind).toBe("doctor");
    expect(suggestKind("Mormor", {}, m)?.kind).toBe("grandparent");
    expect(suggestKind("Rosenhøj Børnehave", { type: "place" }, m)?.kind).toBe("daycare");
    expect(suggestKind("Forældremøde 3.B", { type: "event" }, m)?.kind).toBe("school_event");
  });
  it("uses context and relations, and returns null otherwise", () => {
    expect(suggestKind("Mette", { type: "person", text: "Mette er Emmas klasselærer" }, m)?.kind).toBe("teacher");
    expect(suggestKind("Mette", { type: "person", relations: ["teacher_of"] }, m)?.kind).toBe("teacher");
    expect(suggestKind("Mette", { type: "person" }, m)).toBeNull();
  });
});
