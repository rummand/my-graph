import { describe, expect, it, vi } from "vitest";
import {
  afterUnlink, allowedFields, changedFieldKeys, fieldsToPropagate, pickFields, planPropagation, proposerFor,
  shareableFields, shareTargets, updateSetFor, visibleOthers, type AttrLite, type MemberRow, type ShareableNode,
} from "./pure";
import { propagateChange, type PropagationDeps } from "./propagate";

const LABELS = { label: "Name", kind: "Kind", aliases: "Other names", summary: "Description" };
const anna: ShareableNode = {
  type: "person", kind: "teacher", label: "Anna Holm", aliases: ["Anna"], summary: "Sara's class teacher; prefers mornings.",
  props: { email: "anna@school.dk", phone: "+45 1234 5678", notes: "Private: was upset at the last meeting", health: "asthma", gbrainNotSame: ["x"], birthday: "1980-02-01" },
};
const attrs: AttrLite[] = [
  { key: "email", label: "Email", dataType: "email", sensitive: false },
  { key: "phone", label: "Phone", dataType: "phone", sensitive: false },
  { key: "notes", label: "Notes", dataType: "longtext", sensitive: false },
  { key: "health", label: "Health", dataType: "text", sensitive: true },
  { key: "birthday", label: "Birthday", dataType: "date", sensitive: false },
];

const FAMILY = "g-family", SARA = "g-sara", WORK = "g-work";
const m = (graphId: string, nodeId: string, extra: Partial<MemberRow> = {}): MemberRow => ({
  id: `m-${nodeId}`, identityId: "i1", graphId, nodeId, status: "active", shareFields: ["label", "props.phone"], changeSetId: null, ...extra,
});

describe("field filtering", () => {
  it("offers name, kind, other names, description and contact details, never notes, sensitive or internal props", () => {
    const keys = shareableFields(anna, attrs, LABELS).map((o) => o.key);
    expect(keys).toEqual(["label", "kind", "aliases", "summary", "props.email", "props.phone", "props.birthday"]);
    expect(keys).not.toContain("props.notes");
    expect(keys).not.toContain("props.health");
    expect(keys).not.toContain("props.gbrainNotSame");
  });
  it("ticks contact details by default but not the description", () => {
    const on = shareableFields(anna, attrs, LABELS).filter((o) => o.defaultOn).map((o) => o.key);
    expect(on).toEqual(["label", "kind", "aliases", "props.email", "props.phone"]);
  });
  it("drops fields that may not travel, even when asked for, and always keeps the name", () => {
    const opts = shareableFields(anna, attrs, LABELS);
    expect(allowedFields(["props.notes", "props.health", "props.phone", "facts", "sources"], opts)).toEqual(["label", "props.phone"]);
  });
  it("copies only the chosen fields", () => {
    const p = pickFields(anna, ["label", "props.phone", "props.notes"]);
    expect(p).toEqual({ label: "Anna Holm", props: { phone: "+45 1234 5678" } });
    expect(JSON.stringify(p)).not.toContain("upset");
    expect(pickFields(anna, ["label"]).summary).toBeUndefined();
  });
});

describe("who sees a link", () => {
  const members = [m(FAMILY, "n-fam"), m(SARA, "n-sara"), m(WORK, "n-work")];
  it("a member of both graphs sees the other side", () => {
    const seen = visibleOthers(members, { nodeId: "n-fam", myGraphIds: new Set([FAMILY, SARA]), readable: new Set(["n-fam", "n-sara"]) });
    expect(seen.map((s) => s.graphId)).toEqual([SARA]);
  });
  it("someone only in For Sara sees nothing at all", () => {
    expect(visibleOthers(members, { nodeId: "n-sara", myGraphIds: new Set([SARA]), readable: new Set(["n-sara"]) })).toEqual([]);
  });
  it("a member of both graphs who can't read the other node doesn't see it", () => {
    expect(visibleOthers(members, { nodeId: "n-fam", myGraphIds: new Set([FAMILY, SARA]), readable: new Set(["n-fam"]) })).toEqual([]);
  });
  it("a share waiting to be delivered shows to members of the target graph", () => {
    const ms = [m(FAMILY, "n-fam"), m(SARA, "n-new", { status: "pending", changeSetId: "cs1" })];
    expect(visibleOthers(ms, { nodeId: "n-fam", myGraphIds: new Set([FAMILY, SARA]), readable: new Set(["n-fam"]) })).toHaveLength(1);
  });
  it("nothing shows when the viewed node isn't in a graph of mine", () => {
    expect(visibleOthers(members, { nodeId: "n-work", myGraphIds: new Set([FAMILY, SARA]), readable: new Set(["n-fam", "n-sara", "n-work"]) })).toEqual([]);
  });
  it("share targets are my writable graphs without a copy yet", () => {
    const gs = [{ id: FAMILY, canWrite: true }, { id: SARA, canWrite: true }, { id: WORK, canWrite: false }, { id: "g-x", canWrite: true }];
    expect(shareTargets(gs, { currentGraphId: FAMILY, linkedGraphIds: new Set([SARA]) }).map((g) => g.id)).toEqual(["g-x"]);
  });
});

describe("propagation", () => {
  const target: ShareableNode = { ...anna, props: { phone: "+45 1111 1111", email: "old@x.dk" } };
  it("only fields both sides agreed on travel", () => {
    expect(fieldsToPropagate(["label", "props.phone", "props.email"], ["label", "props.phone", "props.email"], ["label", "props.phone"])).toEqual(["label", "props.phone"]);
  });
  it("detects changed fields", () => {
    expect(changedFieldKeys({ label: "A", props: { phone: "1" } }, { label: "B", props: { phone: "1", email: "e" } })).toEqual(["label", "props.email"]);
  });
  it("builds an update that keeps the target's other props", () => {
    expect(updateSetFor(anna, target, ["props.phone"])).toEqual({ props: { phone: "+45 1234 5678", email: "old@x.dk" } });
    expect(updateSetFor(anna, anna, ["label", "props.phone"])).toBeNull();
  });
  it("plans nothing for fields that weren't agreed", () => {
    expect(planPropagation({ source: anna, sourceFields: ["label"], changed: ["props.phone"], targets: [{ graphId: SARA, nodeId: "n", shareFields: ["label", "props.phone"], node: target }] })).toEqual([]);
  });
  it("only someone in both graphs proposes", () => {
    const base = { changerId: "dad", targetGraphId: SARA, sourceGraphId: FAMILY, linkedBy: "mum" };
    expect(proposerFor({ ...base, changerGraphIds: new Set([FAMILY, SARA]), linkerGraphIds: null })).toBe("dad");
    expect(proposerFor({ ...base, changerGraphIds: new Set([FAMILY]), linkerGraphIds: new Set([FAMILY, SARA]) })).toBe("mum");
    expect(proposerFor({ ...base, changerGraphIds: new Set([FAMILY]), linkerGraphIds: new Set([SARA]) })).toBeNull();
  });

  function deps(over: Partial<PropagationDeps> = {}) {
    const propose = vi.fn(async () => "cs-1");
    const d: PropagationDeps = {
      othersOf: async () => [{ graphId: SARA, nodeId: "n-sara", shareFields: ["label", "props.phone"], linkedBy: "dad" }],
      source: async () => ({ graphId: FAMILY, node: anna, shareFields: ["label", "props.phone"] }),
      proposerIn: async () => "dad",
      targetNode: async () => target,
      propose,
      ...over,
    };
    return { d, propose };
  }
  it("a change creates a proposal in the other graph, and the deps have no way to write", async () => {
    const { d, propose } = deps();
    const r = await propagateChange(d, "n-fam", ["props.phone", "props.notes"]);
    expect(r.proposed).toEqual([{ graphId: SARA, nodeId: "n-sara", changeSetId: "cs-1", fields: ["props.phone"] }]);
    expect(propose).toHaveBeenCalledWith("dad", SARA, { nodeId: "n-sara", label: "Anna Holm", fields: ["props.phone"], set: { props: { phone: "+45 1234 5678", email: "old@x.dk" } } });
    expect(Object.keys(d).some((k) => /write|update|apply|deliver/i.test(k))).toBe(false);
  });
  it("skips, never writes, when versioning isn't available or nobody is in both graphs", async () => {
    const a = deps({ propose: vi.fn(async () => null) });
    expect(await propagateChange(a.d, "n-fam", ["props.phone"])).toEqual({ proposed: [], skipped: 1 });
    const b = deps({ proposerIn: async () => null });
    expect(await propagateChange(b.d, "n-fam", ["props.phone"])).toEqual({ proposed: [], skipped: 1 });
    expect(b.propose).not.toHaveBeenCalled();
  });
});

describe("unlink", () => {
  it("a pair dissolves; with three, the others stay linked", () => {
    expect(afterUnlink([m(FAMILY, "a"), m(SARA, "b")], ["b"]).dissolve).toBe(true);
    const r = afterUnlink([m(FAMILY, "a"), m(SARA, "b"), m(WORK, "c")], ["c"]);
    expect(r.dissolve).toBe(false);
    expect(r.remaining.map((x) => x.nodeId)).toEqual(["a", "b"]);
  });
});
