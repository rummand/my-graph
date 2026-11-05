import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  canSeeSet, emptyNow, fingerprintOf, groupReasons, matchExisting, planDelivery, project, remapMinted, summarize, summaryOf, toStored, verdictsFor,
  type ChangeRowLike, type NodeCand, type Now,
} from "./pure";
import { restoreOps } from "@/lib/history/read-pure";
import { edgeSnap, nodeSnap, type GraphState } from "@/lib/history/pure";

const row = (id: string, seq: number, op: string, extra: Partial<ChangeRowLike> = {}): ChangeRowLike =>
  ({ id, seq, op, nodeId: null, edgeId: null, payload: {}, included: true, ...extra });

type NodeIn = { id: string; type?: string; label: string; kind?: string | null; aliases?: string[]; mergedInto?: string | null; props?: Record<string, unknown> };
function nowWith(nodes: NodeIn[], triples: string[] = []): Now {
  const n = emptyNow();
  for (const x of nodes) {
    n.nodes.set(x.id, { id: x.id, type: x.type ?? "person", label: x.label, aliases: x.aliases ?? [], summary: null, kind: x.kind ?? null, props: x.props ?? {}, startAt: null, endAt: null, visibility: "private", sensitive: false, mergedInto: x.mergedInto ?? null });
    if (!x.mergedInto && x.props?.retired !== true) n.index.push({ id: x.id, type: x.type ?? "person", kind: x.kind ?? null, label: x.label, aliases: x.aliases ?? [] });
  }
  triples.forEach((t, i) => n.triples.set(t, `e-existing-${i}`));
  return n;
}

describe("verdicts", () => {
  it("a new node is outstanding, landed once it exists, and 'exists' (deliverable) when someone else added the same name", () => {
    const c = row("c1", 1, "addNode", { nodeId: "n9", payload: { type: "person", label: "Anna" } });
    expect(verdictsFor([c], nowWith([]))["c1"].verdict).toBe("outstanding");
    expect(verdictsFor([c], nowWith([{ id: "n9", label: "Anna" }]))["c1"].verdict).toBe("landed");
    const v = verdictsFor([c], nowWith([{ id: "n1", label: "Anna" }]))["c1"];
    expect(v.verdict).toBe("exists");
    expect(v.code).toBe("exists");
    expect(v.details?.existing).toMatchObject({ id: "n1", label: "Anna", via: "label" });
  });
  it("a fact needs both ends in the graph or added by the same proposal", () => {
    const add = row("c1", 1, "addNode", { nodeId: "n9", payload: { type: "place", label: "School" } });
    const fact = row("c2", 2, "addEdge", { edgeId: "e9", payload: { fromId: "n1", toId: "n9", relation: "attends" } });
    const now = nowWith([{ id: "n1", label: "Anna" }]);
    expect(verdictsFor([add, fact], now)["c2"].verdict).toBe("outstanding");
    expect(verdictsFor([fact], now)["c2"]).toMatchObject({ verdict: "conflicted", code: "target_missing" });
    // Unticking the node makes the fact depend on something left out when only the ticked ones count.
    expect(verdictsFor([{ ...add, included: false }, fact], now, { includedOnly: true })["c2"]).toMatchObject({ verdict: "conflicted", code: "depends_on_left_out", details: { dependsOn: { changeId: "c1", label: "School" } } });
    expect(verdictsFor([fact], nowWith([{ id: "n1", label: "Anna" }, { id: "n9", type: "place", label: "School" }], ["n1|attends|n9"]))["c2"].verdict).toBe("landed");
  });
  it("updates land when the graph already says it, conflict when the thing is gone", () => {
    const now = nowWith([{ id: "n1", label: "Anna", props: { phone: "1" } }]);
    expect(verdictsFor([row("c", 1, "updateNode", { nodeId: "n1", payload: { set: { props: { phone: "1" } } } })], now)["c"].verdict).toBe("landed");
    expect(verdictsFor([row("c", 1, "updateNode", { nodeId: "n1", payload: { set: { props: { phone: "2" } } } })], now)["c"].verdict).toBe("outstanding");
    expect(verdictsFor([row("c", 1, "updateNode", { nodeId: "n2", payload: { set: { label: "X" } } })], now)["c"].verdict).toBe("conflicted");
  });
  it("merges: landed when done, conflicted across types", () => {
    const now = nowWith([{ id: "a", label: "A" }, { id: "b", label: "B", mergedInto: "a" }, { id: "p", type: "place", label: "P" }]);
    expect(verdictsFor([row("c", 1, "mergeNodes", { payload: { keepId: "a", dropId: "b" } })], now)["c"].verdict).toBe("landed");
    expect(verdictsFor([row("c", 1, "mergeNodes", { payload: { keepId: "a", dropId: "p" } })], now)["c"]).toMatchObject({ verdict: "conflicted", code: "different_types" });
  });
});

describe("fingerprint", () => {
  const ops = [row("c1", 1, "addNode", { nodeId: "n1", payload: { type: "person", label: "A" } }), row("c2", 2, "addEdge", { payload: { fromId: "n1", toId: "n2", relation: "knows" } })];
  it("is stable for the same ops in any order of keys or rows", () => {
    const shuffled = [ops[1], { ...ops[0], payload: { label: "A", type: "person" } }];
    expect(fingerprintOf(shuffled)).toBe(fingerprintOf(ops));
  });
  it("changes when an op is unticked or edited, so an older approval is stale", () => {
    const fp = fingerprintOf(ops);
    expect(fingerprintOf([{ ...ops[0], included: false }, ops[1]])).not.toBe(fp);
    expect(fingerprintOf([{ ...ops[0], payload: { type: "person", label: "B" } }, ops[1]])).not.toBe(fp);
  });
});

describe("who sees a change set", () => {
  const set = { graphId: "g1", createdBy: "u1", forUserId: null };
  it("never across graphs (another graph's proposal reads as not found)", () => {
    expect(canSeeSet({ id: "u1", graphId: "g2", canWrite: true }, set)).toBe(false);
    expect(canSeeSet({ id: "u1", graphId: null, canWrite: true }, set)).toBe(false);
  });
  it("its proposer and the person it waits for; nobody's sets to writers only", () => {
    expect(canSeeSet({ id: "u1", graphId: "g1", canWrite: false }, set)).toBe(true);
    expect(canSeeSet({ id: "u2", graphId: "g1", canWrite: true }, set)).toBe(false);
    expect(canSeeSet({ id: "u2", graphId: "g1", canWrite: false }, { ...set, forUserId: "u2" })).toBe(true);
    expect(canSeeSet({ id: "u2", graphId: "g1", canWrite: true }, { graphId: "g1", createdBy: null, forUserId: null })).toBe(true);
    expect(canSeeSet({ id: "u2", graphId: "g1", canWrite: false }, { graphId: "g1", createdBy: null, forUserId: null })).toBe(false);
  });
});

describe("ops and projection", () => {
  it("mints a node id for a new node, keeps a given one, and pulls ids out of the payload", () => {
    let i = 0;
    const mint = () => `m${++i}`;
    expect(toStored({ op: "addNode", type: "person", label: "A" }, mint)).toMatchObject({ nodeId: "m1", payload: { type: "person", label: "A" } });
    expect(toStored({ op: "addNode", nodeId: "given", type: "person", label: "A" }, mint).nodeId).toBe("given");
    expect(toStored({ op: "removeEdge", edgeId: "e1" }, mint)).toMatchObject({ edgeId: "e1", payload: {} });
  });
  it("reads as a sentence-sized summary with names", () => {
    const names = (id: string) => ({ n1: "Anna", n2: "Ny Skole" } as Record<string, string>)[id] ?? null;
    expect(summaryOf(row("c", 1, "addEdge", { payload: { fromId: "n1", toId: "n2", relation: "attends" } }), names, (k) => (k === "attends" ? "goes to" : k))).toBe("Anna · goes to · Ny Skole");
  });
  it("projects without touching the input", () => {
    const state: GraphState = { nodes: new Map([["n1", nodeSnap({ id: "n1", type: "person", label: "Anna", graphId: "g", ownerId: "u", householdId: "h", visibility: "private" })]]), edges: new Map() };
    const p = project(state, [
      row("c1", 1, "addNode", { nodeId: "n2", payload: { type: "place", label: "School" } }),
      row("c2", 2, "addEdge", { edgeId: "e1", payload: { fromId: "n1", toId: "n2", relation: "attends" } }),
      row("c3", 3, "updateNode", { nodeId: "n1", payload: { set: { summary: "Our girl" } } }),
      row("c4", 4, "addEdge", { payload: { fromId: "n1", toId: "nope", relation: "x" } }),
    ]);
    expect(p.nodes.get("n1")?.summary).toBe("Our girl");
    expect(state.nodes.get("n1")?.summary).toBeNull();
    expect([...p.addedEdges]).toEqual(["e1"]);
    expect(p.problems).toEqual([{ changeId: "c4", why: "endGone" }]);
  });
});

describe("restore", () => {
  const n = (id: string, label: string, ownerId = "me", extra = {}) => nodeSnap({ id, type: "person", label, graphId: "g", ownerId, householdId: "h", visibility: "household", ...extra });
  it("proposes ops that put the viewer's own things back, and leaves others' alone", () => {
    const then: GraphState = { nodes: new Map([["a", n("a", "Mormor")], ["o", n("o", "Old", "other")]]), edges: new Map() };
    const now: GraphState = {
      nodes: new Map([["a", n("a", "Inge")], ["b", n("b", "New")], ["o", n("o", "Changed", "other")]]),
      edges: new Map([["e", edgeSnap({ id: "e", fromId: "a", toId: "b", relation: "knows", status: "confirmed", confidence: 1, graphId: "g", ownerId: "me", householdId: "h", visibility: "household" })]]),
    };
    const r = restoreOps(now, then, "me");
    expect(r.ops).toEqual(expect.arrayContaining([
      expect.objectContaining({ op: "retireNode", nodeId: "b" }),
      expect.objectContaining({ op: "updateNode", nodeId: "a", set: { label: "Mormor" } }),
      expect.objectContaining({ op: "removeEdge", edgeId: "e" }),
    ]));
    expect(r.ops.some((o) => "nodeId" in o && o.nodeId === "o")).toBe(false);
    expect(r.skipped).toBe(1);
  });
});

/*
 * Agents propose, people deliver. Delivery may only be reached from places where a person pressed something:
 * the deliver route, live-highlight Send and approving a suggestion. Outside content (web pages, mail, calendar
 * entries, uploaded files) flows through code that must never deliver, so a prompt injected there can't land anything.
 */
describe("who may deliver", () => {
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const ALLOWED = new Set([
    "lib/changes/index.ts", // the contract itself
    "lib/history/context.ts", // a comment naming it
    "lib/meta/emergent.ts", // a comment naming it
    "app/api/changes/[id]/deliver/route.ts", // a person presses Deliver
    "app/api/changes/deliver-ready/route.ts", // a person presses Deliver all ready and confirms the counts
    "lib/mentions/annotate.ts", // a person presses Send on their own message
    "lib/automations/apply.ts", // a person approves a suggestion
    "lib/profile/facts.ts", // a person adds a fact on a profile and presses Save
    "lib/clinical/items.ts", // a clinician presses Sign or Confirm on a drafted item
    "lib/corpus/graph.ts", // a person presses Approve on a rule set's rules (decideRules)
  ]);
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.ts$/.test(e.name)) files.push(p);
    }
  };
  walk(ROOT);
  it("is only called from person-triggered code", () => {
    const callers = files.filter((f) => /deliverChangeSet|from "\.\/deliver"|from "@\/lib\/changes\/deliver"/.test(fs.readFileSync(f, "utf8")))
      .map((f) => path.relative(ROOT, f).split(path.sep).join("/"))
      .filter((f) => f !== "lib/changes/deliver.ts");
    expect(callers.filter((f) => !ALLOWED.has(f))).toEqual([]);
  });
  it("is never reachable from the code that reads outside content", () => {
    for (const dir of ["lib/web", "lib/connectors", "lib/ingest", "lib/keeper", "lib/links", "lib/artifacts", "lib/design-sets", "lib/assistant", "lib/corpus/crawl", "lib/corpus/read"]) {
      for (const f of files.filter((x) => x.startsWith(path.join(ROOT, dir) + path.sep))) {
        expect(fs.readFileSync(f, "utf8"), path.relative(ROOT, f)).not.toMatch(/deliverChangeSet|changes\/deliver/);
      }
    }
  });
});

/* ── Versioning polish: partial delivery, folding, evidence visibility, retired nodes, writes in history ── */

import { evidenceOpen, evidenceRefs, mergeUpdateSet, restOf, restoreRetiredOps, restTitle } from "./pure";
import { isRetired } from "@/lib/gbrain/pure";

describe("partly delivered", () => {
  const all = [
    row("a", 1, "addNode", { nodeId: "n1", payload: { type: "person", label: "Anna" } }),
    row("b", 2, "addEdge", { payload: { fromId: "n1", toId: "n2", relation: "attends" }, included: false }),
    row("c", 3, "updateNode", { nodeId: "n3", payload: { set: { label: "X" } } }),
  ];
  it("what wasn't delivered keeps waiting, ticked again and renumbered in its old order", () => {
    const rest = restOf(all, new Set(["a"]));
    expect(rest.map((c) => [c.id, c.seq, c.included])).toEqual([["b", 1, true], ["c", 2, true]]);
  });
  it("nothing waits when everything was delivered", () => {
    expect(restOf(all, new Set(["a", "b", "c"]))).toEqual([]);
  });
  it("names the follow-up after the original, never 'Rest of Rest of'", () => {
    expect(restTitle("School letter")).toBe("Rest of School letter");
    expect(restTitle("Rest of School letter")).toBe("Rest of School letter");
    expect(restTitle("Resten af Skolebrev", "Resten af")).toBe("Resten af Skolebrev");
    expect(restTitle("x".repeat(300)).length).toBe(200);
  });
  it("delivery applies the model and reminders inside its one transaction, wiki edits first with undo", () => {
    const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "deliver.ts"), "utf8");
    // The meta library's applyMetaOp opens its own transaction; delivery must not call it.
    expect(src).not.toMatch(/applyMetaOp\(/);
    expect(src).toMatch(/applyMetaOpTx\(tx,/);
    expect(src).not.toMatch(/createReminder\(/);
    expect(src).toMatch(/tx\.insert\(reminders\)/);
    // Wiki edits run before the transaction and are undone if it fails.
    expect(src.indexOf("wiki.updatePage(")).toBeLessThan(src.indexOf("db.transaction("));
    expect(src).toMatch(/catch \(e\) \{\s*scope\.tx = undefined;\s*await undoWiki\(\);/);
  });
});

describe("folding a repeated cross-graph update", () => {
  it("newer fields win and props merge key by key", () => {
    expect(mergeUpdateSet({ label: "Anna", props: { phone: "1", email: "a@x" } }, { props: { phone: "2" }, summary: "s" }))
      .toEqual({ label: "Anna", summary: "s", props: { phone: "2", email: "a@x" } });
  });
  it("a removed value (null) replaces the older one", () => {
    expect(mergeUpdateSet({ props: { phone: "1" } }, { props: { phone: null } })).toEqual({ props: { phone: null } });
  });
  it("folding changes the fingerprint, so an approval of the older version is stale", () => {
    const before = [row("c", 1, "updateNode", { nodeId: "n", payload: { set: { props: { phone: "1" } } } })];
    const after = [{ ...before[0], payload: { set: mergeUpdateSet({ props: { phone: "1" } }, { props: { phone: "2" } }) } }];
    expect(fingerprintOf(after)).not.toBe(fingerprintOf(before));
  });
});

describe("who sees a proposal, by its evidence", () => {
  const shared = new Set(["s-household"]);
  const readable = (id: string) => shared.has(id);
  it("an import of a file every writer may read is open to every writer (co-parents see it)", () => {
    const refs = evidenceRefs({ sourceId: "s-household" }, [{ sourceId: "s-household", quote: "Anna starts school" }, {}]);
    expect(evidenceOpen(refs, readable)).toBe(true);
    const set = { graphId: "g1", createdBy: "mum", forUserId: null, openEvidence: true };
    expect(canSeeSet({ id: "dad", graphId: "g1", canWrite: true }, set)).toBe(true);
    expect(canSeeSet({ id: "kid", graphId: "g1", canWrite: false }, set)).toBe(false);
    expect(canSeeSet({ id: "dad", graphId: "g2", canWrite: true }, set)).toBe(false);
  });
  it("a private source anywhere keeps it with the proposer", () => {
    expect(evidenceOpen(evidenceRefs({}, [{ sourceId: "s-household" }, { sourceId: "s-mums-private" }]), readable)).toBe(false);
    expect(canSeeSet({ id: "dad", graphId: "g1", canWrite: true }, { graphId: "g1", createdBy: "mum", forUserId: null, openEvidence: false })).toBe(false);
    expect(canSeeSet({ id: "mum", graphId: "g1", canWrite: true }, { graphId: "g1", createdBy: "mum", forUserId: null, openEvidence: false })).toBe(true);
  });
  it("a conversation is the person's own, so citing one keeps it private", () => {
    expect(evidenceOpen(evidenceRefs({ conversationId: "c1" }, [{ sourceId: "s-household" }]), readable)).toBe(false);
    expect(evidenceOpen(evidenceRefs({ conversationId: "c1" }, [{ sourceId: "s-household" }]), readable, (c) => c === "c1")).toBe(true);
  });
  it("no evidence, or a quote with nothing behind it, stays private", () => {
    expect(evidenceOpen(evidenceRefs({}, [{}, {}]), readable)).toBe(false);
    expect(evidenceOpen(evidenceRefs({}, [{ sourceId: "s-household" }, { quote: "overheard" }]), readable)).toBe(false);
    expect(evidenceOpen(evidenceRefs({ messageId: "m1" }, [{ sourceId: "s-household" }]), readable)).toBe(false);
  });
  it("the SQL twin checks the same things", () => {
    const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "store.ts"), "utf8");
    const fn = src.slice(src.indexOf("function openEvidenceSql"), src.indexOf("export async function visibleSql"));
    for (const k of ["sourceId", "conversationId", "quote", "messageId", "sourceReadSql", "nodeReadSql"]) expect(fn).toContain(k);
  });
});

describe("retired nodes", () => {
  it("are recognised by their marker", () => {
    expect(isRetired({ retired: true })).toBe(true);
    expect(isRetired({ retired: null, retiredAt: null })).toBe(false);
    expect(isRetired({})).toBe(false);
    expect(isRetired(null)).toBe(false);
  });
  it("come back as a proposal: the marker cleared and the facts replaced at retirement given back", () => {
    const ops = restoreRetiredOps(
      { id: "n1", props: { retired: true, retiredAt: "2026-11-01T10:00:00Z" } },
      [{ edgeId: "e1", was: "confirmed" }, { edgeId: "e2", was: "inferred" }, { edgeId: "e3", was: "confirmed" }, { edgeId: "e1", was: "confirmed" }],
      new Map([["e1", { status: "superseded" }], ["e2", { status: "superseded" }], ["e3", { status: "confirmed" }]]),
    );
    expect(ops).toEqual([
      { op: "updateNode", nodeId: "n1", set: { props: { retired: null, retiredAt: null } }, note: "Bring back what was retired" },
      { op: "updateEdge", edgeId: "e1", set: { status: "confirmed" }, note: "Bring back what was retired" },
      { op: "updateEdge", edgeId: "e2", set: { status: "inferred" }, note: "Bring back what was retired" },
    ]);
    expect(restoreRetiredOps({ id: "n1", props: {} }, [], new Map())).toEqual([]);
  });
  it("are left out of every list reader in gbrain, but not out of reading by id", () => {
    const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../gbrain/index.ts"), "utf8");
    const body = (name: string) => { const i = src.indexOf(`export async function ${name}(`); return src.slice(i, src.indexOf("\nexport ", i + 10)); };
    for (const f of ["listNodes", "search", "timeline", "graph"]) expect(body(f), f).toMatch(/liveNodeSql\("nodes"\)/);
    expect(body("neighbourhood")).toMatch(/isRetired/);
    expect(body("getNode")).not.toMatch(/liveNodeSql|isRetired/);
  });
});

describe("people and members' own nodes are written through gbrain or the history recorder", () => {
  const read = (rel: string) => fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), rel), "utf8");
  it("people writes never touch nodes or edges directly", () => {
    const src = read("../people/writes.ts");
    expect(src).not.toMatch(/(db|tx)\.(insert|update)\((nodes|edges)\)/);
    expect(src).toMatch(/gbrain\.updateNode\(v, id, \{ kind \}/);
  });
  it("a member's self node is recorded in history when it is made or stamped", () => {
    const src = read("../graphs/self.ts");
    expect(src).toMatch(/recordRows\(tx, graph\.id, \{ nodes: \[\[null, nodeSnap\(row\)\]\] \}/);
    expect(src).toMatch(/recordSnapshots\(ex, row\.graphId, before/);
  });
});

/* ── Rebase instead of conflict ──────────────────────────────────────────────────────────────────────── */

const cand = (id: string, label: string, extra: Partial<NodeCand> = {}): NodeCand => ({ id, type: "topic", kind: null, label, aliases: [], ...extra });

describe("matchExisting", () => {
  const index = [cand("bek", "BEK 260", { kind: "regulation" }), cand("anna", "Anna", { type: "person" })];
  it("matches the same type and name, whatever the case and spacing", () => {
    expect(matchExisting({ type: "topic", label: "bek  260" }, index)).toMatchObject({ kind: "exists", node: { id: "bek" }, via: "label" });
    expect(matchExisting({ type: "topic", label: "BEK 261" }, index)).toEqual({ kind: "none" });
    expect(matchExisting({ type: "person", label: "BEK 260" }, index)).toEqual({ kind: "none" });
  });
  it("matches an alias on either side", () => {
    const idx = [cand("i16", "§16-informationsstrømme", { aliases: ["Paragraf 16 informationsstrømme"] })];
    expect(matchExisting({ type: "topic", label: "paragraf 16 informationsstrømme" }, idx)).toMatchObject({ kind: "exists", node: { id: "i16" }, via: "alias" });
    expect(matchExisting({ type: "topic", label: "Informationsstrømme", aliases: ["§16-informationsstrømme"] }, idx)).toMatchObject({ kind: "exists", via: "label" });
  });
  it("a different kind is a kind mismatch; a missing kind on either side is not", () => {
    expect(matchExisting({ type: "topic", label: "BEK 260", kind: "regulation" }, index)).toMatchObject({ kind: "exists" });
    expect(matchExisting({ type: "topic", label: "BEK 260" }, index)).toMatchObject({ kind: "exists" });
    expect(matchExisting({ type: "topic", label: "BEK 260", kind: "project" }, index)).toMatchObject({ kind: "kind_mismatch", candidates: [{ id: "bek" }] });
  });
  it("several matches are ambiguous, never picked", () => {
    const idx = [cand("a", "Energinet"), cand("b", "energinet")];
    expect(matchExisting({ type: "topic", label: "Energinet" }, idx)).toMatchObject({ kind: "ambiguous", candidates: [{ id: "a" }, { id: "b" }] });
    // A label match beats an alias match, so one exact name is still safe.
    expect(matchExisting({ type: "topic", label: "Energinet" }, [cand("a", "Energinet"), cand("c", "TSO", { aliases: ["Energinet"] })])).toMatchObject({ kind: "exists", node: { id: "a" } });
  });
  it("never a retired or merged node", () => {
    expect(matchExisting({ type: "topic", label: "BEK 260" }, [cand("old", "BEK 260", { retired: true })])).toEqual({ kind: "none" });
    expect(matchExisting({ type: "topic", label: "BEK 260" }, [cand("old", "BEK 260", { mergedInto: "x" })])).toEqual({ kind: "none" });
  });
});

describe("remapMinted", () => {
  it("points edges, updates, merges and reminders at the existing node; the add keeps its own id", () => {
    const ops = [
      row("a", 1, "addNode", { nodeId: "new", payload: { type: "topic", label: "BEK 260" } }),
      row("e", 2, "addEdge", { edgeId: "e1", payload: { fromId: "doc", toId: "new", relation: "mentions" } }),
      row("e2", 3, "addEdge", { edgeId: "e2", payload: { fromId: "new", toId: "other", relation: "part_of" } }),
      row("u", 4, "updateNode", { nodeId: "new", payload: { set: { summary: "x" } } }),
      row("m", 5, "mergeNodes", { nodeId: "keep", payload: { keepId: "keep", dropId: "new" } }),
      row("r", 6, "addReminder", { nodeId: "new", payload: { title: "Read it", dueAt: "2026-12-01", aboutNodeId: "new" } }),
    ];
    const out = remapMinted(ops, { new: "bek" });
    expect(out[0].nodeId).toBe("new");
    expect(out[1].payload).toMatchObject({ fromId: "doc", toId: "bek" });
    expect(out[2].payload).toMatchObject({ fromId: "bek", toId: "other" });
    expect(out[3].nodeId).toBe("bek");
    expect(out[4].payload).toMatchObject({ keepId: "keep", dropId: "bek" });
    expect(out[5]).toMatchObject({ nodeId: "bek", payload: { aboutNodeId: "bek" } });
    expect(ops[1].payload.toId).toBe("new"); // the input is untouched
    expect(remapMinted(ops, {})).toBe(ops);
  });
});

describe("reason codes", () => {
  const base = [
    { id: "keep", label: "Ny Skole", type: "place" },
    { id: "drop", label: "Ny skole (gammel)", type: "place", mergedInto: "keep" },
    { id: "ret", label: "Svømning", type: "topic", props: { retired: true, retiredAt: "2026-11-01T10:00:00Z" } },
    { id: "anna", label: "Anna", props: { phone: "1" } },
    { id: "bek", label: "BEK 260", type: "topic", kind: "regulation" },
    { id: "bek2", label: "Energinet", type: "organization" },
    { id: "bek3", label: "Energinet", type: "organization" },
  ];
  const now = nowWith(base);
  now.hidden.add("secret");
  now.readOnly.add("anna");
  now.events.set("ret", [{ kind: "updated", field: "props.retired", at: "2026-11-01T10:00:00Z", by: "Mette", changeSetId: null }]);
  now.events.set("drop", [{ kind: "merged", field: "mergedInto", at: "2026-11-02T10:00:00Z", by: "Dan", changeSetId: null }]);

  it("target_merged names what it was merged into; following the merge makes it deliverable", () => {
    const c = row("c", 1, "addEdge", { payload: { fromId: "anna", toId: "drop", relation: "attends" } });
    expect(verdictsFor([c], now)["c"]).toMatchObject({ verdict: "conflicted", code: "target_merged", details: { mergedInto: { id: "keep", label: "Ny Skole" }, by: "Dan" } });
    const followed = verdictsFor([{ ...c, payload: { ...c.payload, resolution: { follow: true } } }], now)["c"];
    expect(followed).toMatchObject({ verdict: "outstanding", details: { remap: { drop: "keep" } } });
  });
  it("target_retired says who and when", () => {
    const c = row("c", 1, "addEdge", { payload: { fromId: "anna", toId: "ret", relation: "likes" } });
    expect(verdictsFor([c], now)["c"]).toMatchObject({ code: "target_retired", details: { at: "2026-11-01T10:00:00Z", by: "Mette", target: { label: "Svømning" } } });
  });
  it("target_missing and no_permission tell deleted from not visible", () => {
    expect(verdictsFor([row("c", 1, "updateNode", { nodeId: "gone", payload: { set: { label: "x" } } })], now)["c"].code).toBe("target_missing");
    expect(verdictsFor([row("c", 1, "updateNode", { nodeId: "secret", payload: { set: { label: "x" } } })], now)["c"].code).toBe("no_permission");
    expect(verdictsFor([row("c", 1, "updateNode", { nodeId: "anna", payload: { set: { summary: "x" } } })], now)["c"].code).toBe("no_permission");
  });
  it("value_changed shows the graph's value and the proposal's; a decision settles it", () => {
    const n = nowWith([{ id: "lars", label: "Lars", props: { phone: "222" } }]);
    n.events.set("lars", [{ kind: "updated", field: "props.phone", at: "2026-11-03T09:00:00Z", by: "Dan", changeSetId: "other" }]);
    const c = row("c", 1, "updateNode", { nodeId: "lars", payload: { set: { props: { phone: "111" } } } });
    const v = verdictsFor([c], n, { setId: "mine", baseAt: "2026-11-02T00:00:00Z" })["c"];
    expect(v).toMatchObject({ verdict: "conflicted", code: "value_changed", details: { fields: [{ field: "props.phone", now: "222", proposed: "111" }], by: "Dan" } });
    // A change made before the proposal, or by the proposal's own set, is not a conflict.
    expect(verdictsFor([c], n, { setId: "mine", baseAt: "2026-11-04T00:00:00Z" })["c"].verdict).toBe("outstanding");
    expect(verdictsFor([c], n, { setId: "other", baseAt: "2026-11-02T00:00:00Z" })["c"].verdict).toBe("outstanding");
    const keepGraph = { ...c, payload: { ...c.payload, resolution: { keep: "graph" } } };
    expect(verdictsFor([keepGraph], n, { setId: "mine", baseAt: "2026-11-02T00:00:00Z" })["c"]).toMatchObject({ verdict: "landed", code: "kept_graph" });
    const useProposal = { ...c, payload: { ...c.payload, resolution: { keep: "proposal" } } };
    expect(verdictsFor([useProposal], n, { setId: "mine", baseAt: "2026-11-02T00:00:00Z" })["c"].verdict).toBe("outstanding");
  });
  it("ambiguous_existing and kind_mismatch list the candidates; choosing one or 'add as new' settles it", () => {
    const amb = row("a", 1, "addNode", { nodeId: "n1", payload: { type: "organization", label: "Energinet" } });
    expect(verdictsFor([amb], now)["a"]).toMatchObject({ code: "ambiguous_existing", details: { candidates: [{ id: "bek2" }, { id: "bek3" }] } });
    expect(verdictsFor([{ ...amb, payload: { ...amb.payload, resolution: { use: "bek3" } } }], now)["a"]).toMatchObject({ verdict: "exists", details: { existing: { id: "bek3", via: "chosen" } } });
    expect(verdictsFor([{ ...amb, payload: { ...amb.payload, resolution: { asNew: true } } }], now)["a"]).toMatchObject({ verdict: "outstanding", code: "to_add" });
    const km = row("k", 1, "addNode", { nodeId: "n2", payload: { type: "topic", label: "BEK 260", kind: "project" } });
    expect(verdictsFor([km], now)["k"]).toMatchObject({ verdict: "conflicted", code: "kind_mismatch", details: { candidates: [{ id: "bek", kind: "regulation" }] } });
  });
});

describe("delivering onto things that already exist", () => {
  // Document A delivered "BEK 260" and "§16-informationsstrømme" earlier; document B proposes the same plus facts.
  const now = nowWith([
    { id: "docB", label: "Konvention 16", type: "document" },
    { id: "bek", label: "BEK 260", type: "topic" },
    { id: "i16", label: "§16-informationsstrømme", type: "topic" },
  ], ["bek|regulates|i16"]);
  now.origins.set("bek", { changeSetId: "setA", changeSetTitle: "From 'Energinet-ADR.pdf'", sourceId: "srcA", sourceTitle: "Energinet-ADR.pdf", at: "2026-11-04T08:00:00Z", by: "Anna" });
  const ops = [
    row("c1", 1, "addNode", { nodeId: "m-bek", payload: { type: "topic", label: "bek 260" } }),
    row("c2", 2, "addNode", { nodeId: "m-i16", payload: { type: "topic", label: "§16-informationsstrømme" } }),
    row("c3", 3, "addNode", { nodeId: "m-new", payload: { type: "topic", label: "Datadeling" } }),
    row("c4", 4, "addEdge", { edgeId: "x4", payload: { fromId: "docB", toId: "m-bek", relation: "mentions" } }),
    row("c5", 5, "addEdge", { edgeId: "x5", payload: { fromId: "m-bek", toId: "m-i16", relation: "regulates" } }),
    row("c6", 6, "addEdge", { edgeId: "x6", payload: { fromId: "m-new", toId: "m-i16", relation: "part_of" } }),
    row("c7", 7, "updateNode", { nodeId: "m-bek", payload: { set: { summary: "Bekendtgørelse om …" } } }),
  ];
  const reasons = verdictsFor(ops, now, { includedOnly: true });

  it("the adds whose things exist are 'exists'; facts to them are pointed there; a fact already true is landed", () => {
    expect(reasons.c1).toMatchObject({ verdict: "exists", details: { existing: { id: "bek", origin: { sourceTitle: "Energinet-ADR.pdf" } } } });
    expect(reasons.c2.verdict).toBe("exists");
    expect(reasons.c3.verdict).toBe("outstanding");
    expect(reasons.c4).toMatchObject({ verdict: "outstanding", details: { remap: { "m-bek": "bek" } } });
    expect(reasons.c5).toMatchObject({ verdict: "landed", code: "already_true", details: { edgeId: "e-existing-0" } });
    expect(reasons.c6.verdict).toBe("outstanding");
    expect(reasons.c7).toMatchObject({ verdict: "outstanding", details: { remap: { "m-bek": "bek" } } });
  });
  it("the plan skips the adds, keeps their evidence on the existing nodes, and applies the rest pointed at them", () => {
    const plan = planDelivery(ops, reasons);
    expect(plan.conflicts).toEqual([]);
    expect(plan.mapping).toEqual({ "m-bek": "bek", "m-i16": "i16" });
    expect(plan.remapped.map((r) => [r.changeId, r.to, r.existingLabel])).toEqual([["c1", "bek", "BEK 260"], ["c2", "i16", "§16-informationsstrømme"]]);
    const byChange = Object.fromEntries(plan.steps.map((s) => [s.change.id, s]));
    expect(byChange.c1).toMatchObject({ action: "evidence", subject: { type: "node", id: "bek" } });
    expect(byChange.c2).toMatchObject({ action: "evidence", subject: { type: "node", id: "i16" } });
    expect(byChange.c3.action).toBe("apply");
    expect(byChange.c4).toMatchObject({ action: "apply", change: { payload: { fromId: "docB", toId: "bek" } } });
    expect(byChange.c5).toMatchObject({ action: "evidence", subject: { type: "edge", id: "e-existing-0" } });
    expect(byChange.c6).toMatchObject({ action: "apply", change: { payload: { fromId: "m-new", toId: "i16" } } });
    expect(byChange.c7).toMatchObject({ action: "apply", change: { nodeId: "bek" } });
    expect(plan.alreadyTrue).toEqual([{ changeId: "c5", edgeId: "e-existing-0" }]);
  });
  it("the mapping is not part of the fingerprint: an approval stays valid", () => {
    // Verdicts are computed at delivery from the graph; the stored ops (and so the fingerprint) never change.
    const before = fingerprintOf(ops);
    planDelivery(ops, reasons);
    expect(fingerprintOf(ops)).toBe(before);
  });
  it("summarises and groups: the matches by where they came from", () => {
    const s = summarize(ops, reasons);
    expect(s).toMatchObject({ total: 7, included: 7, ready: 7, exists: 2, landed: 1, toDo: 4, needsYou: 0, deliverable: true, nothingNew: false });
    const groups = groupReasons(ops, reasons);
    expect(groups.map((g) => [g.code, g.changeIds.length])).toEqual([["exists", 1], ["exists", 1], ["landed", 1]]);
    expect(groups[0].origin?.sourceTitle).toBe("Energinet-ADR.pdf");
  });
  it("a set that only says what the graph already says is 'nothing new': evidence only", () => {
    const same = [ops[0], ops[1], ops[4]];
    const r = verdictsFor(same, now, { includedOnly: true });
    const s = summarize(same, r);
    expect(s).toMatchObject({ nothingNew: true, deliverable: true, toDo: 0 });
    const plan = planDelivery(same, r);
    expect(plan.steps.every((x) => x.action === "evidence")).toBe(true);
  });
  it("problems need a person: counted, grouped first, and never in the plan", () => {
    const bad = [...ops, row("c8", 8, "addEdge", { payload: { fromId: "docB", toId: "nowhere", relation: "mentions" } })];
    const r = verdictsFor(bad, now, { includedOnly: true });
    expect(summarize(bad, r)).toMatchObject({ needsYou: 1, deliverable: false });
    expect(groupReasons(bad, r)[0]).toMatchObject({ code: "target_missing", changeIds: ["c8"] });
    expect(planDelivery(bad, r).conflicts).toEqual(["c8"]);
  });
});
