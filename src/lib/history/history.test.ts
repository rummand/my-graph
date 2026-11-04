import { describe, expect, it } from "vitest";
import { coalesce, diffEdge, diffNode, diffStates, edgeSnap, nodeSnap, rewind, sameHand, type GraphState, type StoredEvent } from "./pure";

const base = { graphId: "g1", ownerId: "u1", householdId: "h1", visibility: "household" as const };
const node = (id: string, label: string, extra: Partial<Parameters<typeof nodeSnap>[0]> = {}) => nodeSnap({ id, type: "person", label, ...base, ...extra });
const edge = (id: string, fromId: string, toId: string, extra: Partial<Parameters<typeof edgeSnap>[0]> = {}) =>
  edgeSnap({ id, fromId, toId, relation: "knows", status: "confirmed", confidence: 1, ...base, ...extra });

describe("diffing", () => {
  it("records one event per field that moved, props key by key, internal props ignored", () => {
    const a = node("n1", "Mormor", { summary: null, props: { email: "a@x.dk", gbrainNotSame: ["x"] } });
    const b = node("n1", "Inge", { summary: "Grandma", props: { email: "b@x.dk", phone: "123", gbrainNotSame: ["x", "y"] } });
    const d = diffNode(a, b);
    expect(d.map((e) => e.field)).toEqual(["label", "summary", "props.email", "props.phone"]);
    expect(d[0]).toMatchObject({ kind: "updated", fromValue: "Mormor", toValue: "Inge" });
  });
  it("creation and removal carry the whole snapshot; facts carry both ends", () => {
    expect(diffNode(null, node("n1", "A"))[0]).toMatchObject({ kind: "created", field: null });
    const e = diffEdge(edge("e1", "a", "b"), null)[0];
    expect(e).toMatchObject({ kind: "removed", fromNodeId: "a", toNodeId: "b" });
    expect(diffEdge(edge("e1", "a", "b"), edge("e1", "a", "b", { status: "rejected" }))[0]).toMatchObject({ field: "status", fromValue: "confirmed", toValue: "rejected" });
  });
  it("a merge reads as merged", () => {
    expect(diffNode(node("n2", "B"), node("n2", "B", { mergedInto: "n1" }))[0].kind).toBe("merged");
  });
});

describe("coalescing", () => {
  const ev = (from: unknown, to: unknown) => ({ subjectType: "node" as const, subjectId: "n1", subjectName: "A", kind: "updated" as const, field: "label", fromValue: from, toValue: to });
  it("extends a run of edits to the same field", () => {
    expect(coalesce({ kind: "updated", field: "label", fromValue: "A", toValue: "AB" }, ev("AB", "ABC"))).toEqual({ action: "extend", from: "A", to: "ABC" });
  });
  it("drops the line when the edit is undone", () => {
    expect(coalesce({ kind: "updated", field: "label", fromValue: "A", toValue: "AB" }, ev("AB", "A"))).toEqual({ action: "drop" });
  });
  it("keeps separate lines for other fields, a broken chain or a creation", () => {
    expect(coalesce({ kind: "updated", field: "summary", fromValue: "A", toValue: "AB" }, ev("AB", "C")).action).toBe("insert");
    expect(coalesce({ kind: "updated", field: "label", fromValue: "A", toValue: "AB" }, ev("X", "C")).action).toBe("insert");
    expect(coalesce({ kind: "created", field: null, fromValue: null, toValue: {} }, ev("A", "B")).action).toBe("insert");
  });
  it("only the same hand within two minutes counts", () => {
    const a = { actorKind: "person", actorId: "u1", changeSetId: null, context: "gbrain:manual_edit", at: "2026-01-01T10:00:00Z" };
    expect(sameHand(a, { ...a, at: "2026-01-01T10:01:59Z" })).toBe(true);
    expect(sameHand(a, { ...a, at: "2026-01-01T10:02:01Z" })).toBe(false);
    expect(sameHand(a, { ...a, actorId: "u2" })).toBe(false);
    expect(sameHand(a, { ...a, actorKind: "assistant" })).toBe(false);
    expect(sameHand(a, { ...a, changeSetId: "cs1" })).toBe(false);
  });
});

describe("rewind", () => {
  const now: GraphState = {
    nodes: new Map([["n1", node("n1", "Inge", { props: { phone: "2" } })], ["n2", node("n2", "School")], ["n3", node("n3", "Back")]]),
    edges: new Map([["e1", edge("e1", "n1", "n2", { status: "rejected" })]]),
  };
  const events: StoredEvent[] = [
    { id: "1", subjectType: "node", subjectId: "n1", kind: "created", field: null, fromValue: null, toValue: node("n1", "Mormor"), at: "2026-01-01T09:00:00Z" },
    { id: "2", subjectType: "node", subjectId: "n1", kind: "updated", field: "label", fromValue: "Mormor", toValue: "Inge", at: "2026-01-02T09:00:00Z" },
    { id: "3", subjectType: "node", subjectId: "n2", kind: "created", field: null, fromValue: null, toValue: node("n2", "School"), at: "2026-01-03T09:00:00Z" },
    { id: "4", subjectType: "edge", subjectId: "e1", kind: "created", field: null, fromValue: null, toValue: edge("e1", "n1", "n2"), fromNodeId: "n1", toNodeId: "n2", at: "2026-01-03T10:00:00Z" },
    { id: "5", subjectType: "node", subjectId: "n1", kind: "updated", field: "props.phone", fromValue: null, toValue: "2", at: "2026-01-04T09:00:00Z" },
    { id: "6", subjectType: "edge", subjectId: "e1", kind: "updated", field: "status", fromValue: "confirmed", toValue: "rejected", fromNodeId: "n1", toNodeId: "n2", at: "2026-01-05T09:00:00Z" },
    { id: "7", subjectType: "node", subjectId: "n4", kind: "removed", field: null, fromValue: node("n4", "Gone"), toValue: null, at: "2026-01-06T09:00:00Z" },
  ];
  it("undoes everything newer than the moment, newest first", () => {
    const at = rewind(now, events, new Date("2026-01-02T12:00:00Z"));
    expect(at.nodes.get("n1")?.label).toBe("Inge");
    expect(at.nodes.has("n2")).toBe(false);
    expect(at.edges.has("e1")).toBe(false);
    expect(at.nodes.get("n1")?.props.phone).toBeUndefined();
    expect(at.nodes.get("n4")?.label).toBe("Gone");
    expect(at.nodes.has("n3")).toBe(true); // older than the log: stays as it is
  });
  it("gets each field right at each moment", () => {
    expect(rewind(now, events, new Date("2026-01-01T12:00:00Z")).nodes.get("n1")?.label).toBe("Mormor");
    const mid = rewind(now, events, new Date("2026-01-04T12:00:00Z"));
    expect(mid.edges.get("e1")?.status).toBe("confirmed");
    expect(mid.nodes.get("n1")?.props.phone).toBe("2");
    expect(rewind(now, events, new Date("2025-12-31T00:00:00Z")).nodes.has("n1")).toBe(false);
  });
  it("never changes the state it was given", () => {
    rewind(now, events, new Date("2026-01-01T00:00:00Z"));
    expect(now.nodes.get("n1")?.label).toBe("Inge");
    expect(now.edges.get("e1")?.status).toBe("rejected");
  });
  it("diffs two moments: added, gone, changed; inactive facts count as gone", () => {
    const a = rewind(now, events, new Date("2026-01-04T12:00:00Z"));
    const d = diffStates(a, now);
    expect(d.edgesRemoved.map((e) => e.id)).toEqual(["e1"]);
    expect(d.nodesRemoved.map((n) => n.id)).toEqual(["n4"]);
    expect(d.nodesAdded).toEqual([]);
  });
});
