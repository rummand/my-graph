import { describe, expect, it } from "vitest";
import { BUILTIN_KINDS, BUILTIN_RELATIONS } from "@/lib/meta/builtins";
import { mergeMetaModel } from "@/lib/meta/model";
import { memberCircle, relationToYou, relationsToCenter, type PathEdge, type PathNode } from "@/lib/people/relpath";
import { selfLine } from "@/lib/people/context";
import type { PersonSummary } from "@/lib/people/types";
import { relationOptions, youPresets } from "@/components/people/relation-options";
import {
  isSelfOf, pickSelfNode, selfKind, selfProps, selfUserOf, selfVisibility, stripReservedProps, type SelfCandidate,
} from "./pure";

const ANNA = "u-anna", SARA = "u-sara";
const at = (n: number) => new Date(Date.UTC(2026, 0, n));
const row = (r: Partial<SelfCandidate> & { id: string }): SelfCandidate =>
  ({ label: "Anna", props: {}, mergedInto: null, ownerId: ANNA, createdAt: at(1), ...r });

describe("self node marker", () => {
  it("marks and reads the member a node stands for", () => {
    expect(selfProps(ANNA)).toEqual({ userId: ANNA, self: true });
    expect(selfUserOf(selfProps(ANNA))).toBe(ANNA);
    expect(isSelfOf(selfProps(ANNA), ANNA)).toBe(true);
    expect(isSelfOf(selfProps(ANNA), SARA)).toBe(false);
    expect(selfUserOf({ userId: ANNA })).toBeNull();
    expect(selfUserOf({ self: "true", userId: ANNA })).toBeNull();
    expect(selfUserOf(null)).toBeNull();
  });

  it("never lets people write the marker themselves", () => {
    expect(stripReservedProps({ self: true, userId: SARA, householdMember: true, phone: "1234" })).toEqual({ phone: "1234" });
  });

  it("is visible to every member, except a guest in the family graph", () => {
    expect(selfVisibility("owner", false)).toBe("household");
    expect(selfVisibility("guest", false)).toBe("household");
    expect(selfVisibility("guest", true)).toBe("private");
    expect(selfVisibility("child", true)).toBe("household");
  });

  it("only children in their own family graph get a kind", () => {
    expect(selfKind("child", true)).toBe("child");
    expect(selfKind("child", false)).toBeNull();
    expect(selfKind("owner", true)).toBeNull();
  });
});

describe("finding a member's self node", () => {
  it("uses the family node (users.personNodeId) when it is in this graph", () => {
    const rows = [row({ id: "marked", props: selfProps(ANNA), createdAt: at(1) }), row({ id: "home", createdAt: at(2) })];
    expect(pickSelfNode(rows, ANNA, "home")?.id).toBe("home");
  });

  it("falls back to the oldest live node marked as theirs", () => {
    const rows = [
      row({ id: "merged", props: selfProps(ANNA), mergedInto: "x", createdAt: at(1) }),
      row({ id: "newer", props: selfProps(ANNA), createdAt: at(3) }),
      row({ id: "older", props: selfProps(ANNA), createdAt: at(2) }),
    ];
    expect(pickSelfNode(rows, ANNA, "elsewhere")?.id).toBe("older");
  });

  it("ignores a marker on a node someone else owns (nobody can claim to be you)", () => {
    expect(pickSelfNode([row({ id: "fake", ownerId: SARA, props: selfProps(ANNA) })], ANNA, null)).toBeNull();
  });

  it("adopts an unmarked node you own with your name, only when asked", () => {
    const rows = [row({ id: "named", label: " anna " }), row({ id: "other", label: "Bo" })];
    expect(pickSelfNode(rows, ANNA, null)).toBeNull();
    expect(pickSelfNode(rows, ANNA, null, "Anna")?.id).toBe("named");
    // A node marked for someone else is never adopted, nor one owned by someone else with your name.
    expect(pickSelfNode([row({ id: "sara", props: selfProps(SARA) })], ANNA, null, "Anna")).toBeNull();
    expect(pickSelfNode([row({ id: "hers", ownerId: SARA })], ANNA, null, "Anna")).toBeNull();
  });
});

const meta = mergeMetaModel("hh", {
  kinds: BUILTIN_KINDS.map((k, i) => ({ id: `k${i}`, householdId: null, nodeType: k.nodeType, key: k.key, label: k.label, pluralLabel: null, description: null, circle: k.circle ?? null, parentKey: null, icon: null, color: null, sortOrder: i, builtin: true })),
  relations: BUILTIN_RELATIONS.map((r, i) => ({ id: `r${i}`, householdId: null, key: r.key, label: r.label, inverseLabel: r.inverseLabel, category: r.category, fromTypes: r.fromTypes, toTypes: r.toTypes, symmetric: !!r.symmetric, builtin: true })),
  attributes: [],
});

describe("relations to you, in a work graph", () => {
  const nodes = new Map<string, PathNode>([
    ["me", { id: "me", label: "Anna", type: "person", kind: null }],
    ["boss", { id: "boss", label: "Bo", type: "person", kind: "manager" }],
    ["lise", { id: "lise", label: "Lise", type: "person", kind: "colleague" }],
    ["kim", { id: "kim", label: "Kim", type: "person", kind: null }],
    ["ole", { id: "ole", label: "Ole", type: "person", kind: null }],
  ]);
  const edges: PathEdge[] = [
    { id: "1", fromId: "boss", toId: "me", relation: "manager_of" },
    { id: "2", fromId: "lise", toId: "me", relation: "colleague_of" },
    { id: "3", fromId: "me", toId: "kim", relation: "manager_of" },
    { id: "4", fromId: "ole", toId: "me", relation: "knows" },
  ];
  const fromMe = relationsToCenter(meta, "me", nodes, edges, { centerIsViewer: true });

  it("reads naturally on the circles", () => {
    expect(fromMe.get("boss")?.label).toBe("Your manager");
    expect(fromMe.get("lise")?.label).toBe("Your colleague");
    expect(fromMe.get("kim")?.label).toBe("Reports to you");
    expect(fromMe.get("ole")?.label).toBe("Knows you");
  });

  it("reads naturally on the person's page", () => {
    expect(relationToYou(meta, edges[0], nodes.get("boss")!)).toBe("Your manager");
    expect(relationToYou(meta, edges[2], nodes.get("kim")!)).toBe("Reports to you");
    expect(relationToYou(meta, edges[3], nodes.get("ole")!)).toBe("Knows you");
  });

  it("puts fellow members with no relation where the graph puts its people", () => {
    expect(memberCircle("work")).toBe("work");
    expect(memberCircle("family")).toBe("family");
    expect(memberCircle("shared")).toBe("other");
  });
});

describe("how do they know you?", () => {
  const options = relationOptions(meta.relations);
  const kinds = meta.kinds.filter((k) => k.nodeType === "person").map((k) => k.key);

  it("leads with work in a work graph, and every preset is a real relation", () => {
    const p = youPresets("work", options, kinds);
    expect(p.map((x) => x.id)).toEqual(["manager", "report", "colleague", "friend", "knows"]);
    expect(p[0]).toMatchObject({ label: "My manager", kind: "manager", rel: "manager_of:out" });
    for (const x of youPresets("family", options, kinds)) expect(options.some((o) => o.value === x.rel)).toBe(true);
  });

  it("drops presets whose relation is hidden, and kinds that don't exist", () => {
    const noManager = relationOptions(meta.relations.map((r) => (r.key === "manager_of" ? { ...r, hidden: true } : r)));
    expect(youPresets("work", noManager, kinds).some((x) => x.rel.startsWith("manager_of"))).toBe(false);
    expect(youPresets("work", options, []).every((x) => x.kind === null)).toBe(true);
  });
});

describe("who the viewer is, for the assistant", () => {
  const person = (p: Partial<PersonSummary> & { id: string; label: string }): PersonSummary => ({
    kind: null, kindLabel: null, circle: "work", visibility: "household", sensitive: false, ownerId: ANNA, householdMember: false,
    isViewer: false, relation: null, lastContactAt: null, lastContactSource: null, contactCount90: 0, wellbeing: [], birthday: null,
    nextBirthday: null, openReminders: 0, createdAt: at(1).toISOString(), ...p,
  });
  it("names you, the graph, how people relate to you and who else is in it", () => {
    const me = person({ id: "me", label: "Anna", isViewer: true, householdMember: true });
    const boss = person({ id: "boss", label: "Bo", relation: { label: "Your manager", hops: 1, via: null, relation: "manager_of", category: "work" } });
    const sara = person({ id: "sara", label: "Sara", householdMember: true });
    const line = selfLine("Anna", "Work", me, [me, boss, sara]);
    expect(line).toContain("You are Anna (person id me) in the graph \"Work\"");
    expect(line).toContain("Your manager: Bo.");
    expect(line).toContain("Also in this graph: Sara.");
  });
});
