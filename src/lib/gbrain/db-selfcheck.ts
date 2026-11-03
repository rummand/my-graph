/** Integration check against a real database (creates and deletes a throwaway household).
 *  Run: npx tsx --env-file=.env src/lib/gbrain/db-selfcheck.ts */
import { db, sql } from "@/db";
import { households, users, nodes, shares, sources, chunks } from "@/db/schema";
import * as g from "@/lib/gbrain";
import type { Viewer } from "@/lib/auth";
import { eq } from "drizzle-orm";

const assert = (c: unknown, m: string) => { if (!c) { console.error("FAIL", m); process.exitCode = 1; } else console.log("ok  ", m); };
const [hh] = await db.insert(households).values({ name: "gbrain-selfcheck" }).returning();
const [hh2] = await db.insert(households).values({ name: "gbrain-selfcheck-2" }).returning();
const mk = async (role: any, name: string, h = hh.id, exp: Date | null = null) => {
  const [u] = await db.insert(users).values({ householdId: h, email: `${name}-${Date.now()}@x.test`, name, role, accessExpiresAt: exp }).returning();
  return { id: u.id, householdId: h, name, email: u.email, role, personNodeId: null } as Viewer;
};
try {
  const owner = await mk("owner", "Olivia"), parent = await mk("parent", "Peter"), child = await mk("child", "Carl");
  const guest = await mk("guest", "Gina", hh.id, new Date(Date.now() + 86400e3)), oldGuest = await mk("guest", "Old", hh.id, new Date(Date.now() - 1000));
  const stranger = await mk("owner", "Stan", hh2.id);
  const P = (v: Viewer) => ({ activity: "manual_edit" as const, agentType: "user" as const, agentId: v.id });

  const a = await g.upsertNode(owner, { type: "person", label: "Søren Ågård", summary: "Grandfather" }, P(owner));
  const b = await g.upsertNode(owner, { type: "person", label: "soeren aagaard" }, { ...P(owner), quote: "x" });
  assert(a.created && !b.created && a.node.id === b.node.id, "entity resolution reuses node across diacritics");
  const c = await g.upsertNode(owner, { type: "person", label: "Søren Agård", aliases: ["Farfar"] }, P(owner));
  assert(c.created, "near-duplicate creates new node");
  const priv = await g.upsertNode(owner, { type: "topic", label: "Taxes" }, P(owner));
  const hhNode = await g.upsertNode(owner, { type: "place", label: "Skolen", visibility: "household" }, P(owner));
  const parNode = await g.upsertNode(owner, { type: "topic", label: "Parenting", visibility: "parents" }, P(owner));
  const sens = await g.upsertNode(owner, { type: "topic", label: "Health", visibility: "household", sensitive: true }, P(owner));
  assert(sens.node.visibility === "household", "explicit visibility honoured");
  const sensDefault = await g.upsertNode(owner, { type: "topic", label: "Diagnosis", sensitive: true }, P(owner));
  assert(sensDefault.node.visibility === "parents", "sensitive defaults to parents");

  const ids = (l: { id: string }[]) => new Set(l.map((x) => x.id));
  const seen = async (v: Viewer) => ids(await g.listNodes(v, { limit: 500 }));
  const sp = await seen(parent), sc = await seen(child), sg = await seen(guest), ss = await seen(stranger);
  assert(sp.has(hhNode.node.id) && sp.has(parNode.node.id) && !sp.has(priv.node.id) && sp.has(sens.node.id), "parent sees household+parents, not private");
  assert(sc.has(hhNode.node.id) && !sc.has(parNode.node.id) && !sc.has(sens.node.id), "child: household only, no sensitive");
  assert(sg.size === 0 && ss.size === 0, "guest/stranger see nothing unshared");
  await db.insert(shares).values({ nodeId: priv.node.id, userId: guest.id, canEdit: false });
  await db.insert(shares).values({ nodeId: priv.node.id, userId: oldGuest.id, canEdit: true });
  await db.insert(shares).values({ nodeId: hhNode.node.id, userId: guest.id, expiresAt: new Date(Date.now() - 1000) });
  assert((await seen(guest)).has(priv.node.id) && (await seen(guest)).size === 1, "guest sees active share only");
  assert((await seen(oldGuest)).size === 0, "expired guest sees nothing");
  assert(await g.canRead(guest, priv.node) && !(await g.canEdit(guest, priv.node)) && !(await g.canEdit(oldGuest, priv.node)), "canRead/canEdit for guests");
  assert(!(await g.canRead(child, sens.node)) && await g.canRead(parent, sens.node) && await g.canEdit(owner, sens.node) && !(await g.canEdit(parent, sens.node)), "canRead/canEdit roles");

  // SQL vs pure consistency for every viewer x node
  const all = await db.select().from(nodes).where(eq(nodes.householdId, hh.id));
  for (const v of [owner, parent, child, guest, oldGuest, stranger]) {
    const s = await seen(v);
    for (const n of all) if (!n.mergedInto) {
      const pure = await g.canRead(v, n as any);
      if (pure !== s.has(n.id)) assert(false, `pure/sql mismatch ${v.name} ${n.label}`);
    }
  }
  console.log("ok   pure/sql consistency checked");

  const e1 = await g.addEdge(owner, { fromId: a.node.id, toId: hhNode.node.id, relation: "Attends", confidence: 0.5 }, { activity: "llm_extraction", agentType: "model", agentId: "mux:test", confidence: 0.5 });
  const e2 = await g.addEdge(owner, { fromId: a.node.id, toId: hhNode.node.id, relation: "attends" }, { activity: "llm_extraction", agentType: "model", agentId: "mux:test", confidence: 0.6 });
  assert(e1.id === e2.id && Math.abs(e2.confidence - 0.8) < 1e-6 && e2.status === "unconfirmed", `edge dedup + noisy-or (${e2.confidence})`);
  assert(e1.visibility === "private", "edge visibility = narrower endpoint");
  const pv = await g.explain(owner, { type: "edge", id: e1.id });
  assert(pv.length === 2, "edge has 2 provenance rows");
  const e3 = await g.addEdge(owner, { fromId: hhNode.node.id, toId: parNode.node.id, relation: "about", visibility: "household" }, P(owner));
  assert(e3.status === "confirmed", "user-asserted fact is confirmed");
  const nbChild = await g.neighbourhood(child, hhNode.node.id);
  assert(nbChild.edges.length === 0, "child can't see edge to parents-only node");
  const nbParent = await g.neighbourhood(parent, hhNode.node.id);
  assert(nbParent.edges.length === 1 && nbParent.nodes.length === 2, "parent sees household edge");
  const conf = await g.setEdgeStatus(owner, e1.id, "confirmed");
  assert(conf.status === "confirmed" && conf.confidence === 1, "confirm");
  let threw = false; try { await g.setEdgeStatus(parent, e3.id, "rejected"); } catch (e: any) { threw = e.status === 403; }
  assert(threw, "parent can't change owner's fact");
  const corrected = await g.correctEdge(owner, e3.id, { relation: "tagged_with" });
  const oldExplain = await g.explain(owner, { type: "edge", id: e3.id });
  assert(corrected.relation === "tagged_with" && oldExplain.length === 2, "correct supersedes with provenance");
  assert((await g.neighbourhood(owner, hhNode.node.id)).edges.every((e) => e.id !== e3.id), "superseded hidden");

  // merge
  await g.addEdge(owner, { fromId: c.node.id, toId: hhNode.node.id, relation: "attends" }, { activity: "llm_extraction", agentType: "model", agentId: "mux:t", confidence: 0.5 });
  const sugg = await g.mergeSuggestions(owner);
  assert(sugg.some((s) => new Set([s.a.id, s.b.id]).has(a.node.id) && new Set([s.a.id, s.b.id]).has(c.node.id)), `merge suggestion found: ${sugg.map((s) => s.reason).join("; ")}`);
  const merged = await g.mergeNodes(owner, a.node.id, c.node.id);
  assert(merged.aliases.includes("Farfar") && merged.aliases.includes("Søren Agård"), "aliases merged");
  const nb = await g.neighbourhood(owner, a.node.id);
  assert(nb.edges.filter((e) => e.relation === "attends").length === 1, "duplicate facts folded after merge");
  assert((await g.getNode(owner, c.node.id))?.id === a.node.id, "getNode follows merge");
  assert(!(await g.listNodes(owner, { limit: 500 })).some((n) => n.id === c.node.id), "merged hidden from list");
  const fa = nb.edges.find((e) => e.relation === "attends")!;
  assert((await g.explain(owner, { type: "edge", id: fa.id })).length >= 4, "provenance copied to folded fact");

  // search
  const [src] = await db.insert(sources).values({ householdId: hh.id, ownerId: owner.id, kind: "manual", title: "Note", visibility: "household" }).returning();
  await db.insert(chunks).values({ sourceId: src.id, ownerId: owner.id, idx: 0, text: "Farfar kommer på besøg i skolen på fredag" });
  const hits = await g.search(owner, "farf");
  assert(hits.some((h) => h.kind === "node" && h.node?.id === a.node.id) && hits.some((h) => h.kind === "chunk"), "search finds node by alias prefix and chunk");
  const hitsBes = await g.search(child, "besøg");
  assert(hitsBes.some((h) => h.kind === "chunk"), "danish word search in chunks for child (household source)");
  assert((await g.search(guest, "besøg")).length === 0, "guest gets no chunks");
  assert((await g.search(owner, "skolen fredag zzzz")).length > 0, "OR fallback");

  // timeline
  const ev = await g.upsertNode(owner, { type: "event", label: "School start", startAt: new Date("2026-08-10"), timePrecision: "day", visibility: "household" }, P(owner));
  await g.addEdge(owner, { fromId: ev.node.id, toId: a.node.id, relation: "involves" }, P(owner));
  const tl = await g.timeline(owner, { personIds: [a.node.id] });
  assert(tl.events.length === 1 && tl.involves.length === 1, "timeline by person");
  const tl2 = await g.timeline(owner, { from: new Date("2027-01-01") });
  assert(tl2.events.length === 0, "timeline window");
  const gr = await g.graph(owner, {});
  assert(gr.nodes.length > 3 && gr.edges.length >= 2, `graph ${gr.nodes.length}/${gr.edges.length}`);
  const upd = await g.updateNode(owner, a.node.id, { label: "Søren A." }, P(owner));
  assert(upd.aliases.includes("Søren Ågård"), "rename keeps old name as alias");
  await g.dismissMergeSuggestion(owner, priv.node.id, parNode.node.id);
  try { await g.upsertNode(guest, { type: "topic", label: "x" }, P(guest)); assert(false, "guest write blocked"); } catch (e: any) { assert(e.status === 403, "guest write blocked"); }
} finally {
  await db.delete(households).where(eq(households.id, hh.id));
  await db.delete(households).where(eq(households.id, hh2.id));
  await sql.end();
}
