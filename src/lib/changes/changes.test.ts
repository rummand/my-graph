import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canSeeSet, emptyNow, fingerprintOf, project, summaryOf, toStored, verdictsFor, type ChangeRowLike, type Now } from "./pure";
import { restoreOps } from "@/lib/history/read-pure";
import { edgeSnap, nodeSnap, type GraphState } from "@/lib/history/pure";

const row = (id: string, seq: number, op: string, extra: Partial<ChangeRowLike> = {}): ChangeRowLike =>
  ({ id, seq, op, nodeId: null, edgeId: null, payload: {}, included: true, ...extra });

function nowWith(nodes: { id: string; type?: string; label: string; mergedInto?: string | null; props?: Record<string, unknown> }[], triples: string[] = []): Now {
  const n = emptyNow();
  for (const x of nodes) {
    n.nodes.set(x.id, { id: x.id, type: x.type ?? "person", label: x.label, aliases: [], summary: null, kind: null, props: x.props ?? {}, startAt: null, endAt: null, visibility: "private", sensitive: false, mergedInto: x.mergedInto ?? null });
    if (!x.mergedInto) n.names.set(`${x.type ?? "person"}:${x.label.toLowerCase()}`, x.id);
  }
  for (const t of triples) n.triples.add(t);
  return n;
}

describe("verdicts", () => {
  it("a new node is outstanding, landed once it exists, conflicted when someone else added the same name", () => {
    const c = row("c1", 1, "addNode", { nodeId: "n9", payload: { type: "person", label: "Anna" } });
    expect(verdictsFor([c], nowWith([]))["c1"].verdict).toBe("outstanding");
    expect(verdictsFor([c], nowWith([{ id: "n9", label: "Anna" }]))["c1"].verdict).toBe("landed");
    expect(verdictsFor([c], nowWith([{ id: "n1", label: "Anna" }]))["c1"]).toEqual({ verdict: "conflicted", why: "sameName" });
  });
  it("a fact needs both ends in the graph or added by the same proposal", () => {
    const add = row("c1", 1, "addNode", { nodeId: "n9", payload: { type: "place", label: "School" } });
    const fact = row("c2", 2, "addEdge", { edgeId: "e9", payload: { fromId: "n1", toId: "n9", relation: "attends" } });
    const now = nowWith([{ id: "n1", label: "Anna" }]);
    expect(verdictsFor([add, fact], now)["c2"].verdict).toBe("outstanding");
    expect(verdictsFor([fact], now)["c2"]).toEqual({ verdict: "conflicted", why: "endGone" });
    // Unticking the node makes the fact conflict when only the ticked ones count.
    expect(verdictsFor([{ ...add, included: false }, fact], now, { includedOnly: true })["c2"].verdict).toBe("conflicted");
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
    expect(verdictsFor([row("c", 1, "mergeNodes", { payload: { keepId: "a", dropId: "p" } })], now)["c"]).toEqual({ verdict: "conflicted", why: "differentTypes" });
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
    "lib/mentions/annotate.ts", // a person presses Send on their own message
    "lib/automations/apply.ts", // a person approves a suggestion
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
    for (const dir of ["lib/web", "lib/connectors", "lib/ingest", "lib/keeper", "lib/links", "lib/artifacts", "lib/design-sets", "lib/assistant"]) {
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
