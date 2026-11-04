import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/auth", async (orig) => ({ ...(await orig<typeof import("@/lib/auth")>()), audit: async () => {}, getViewer: async () => null }));
import { db, sql } from "@/db";
import { changeSets, edges, households, metaKinds, nodes, provenance, sources, users } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { viewerFor } from "@/lib/graphs/store";
import { getNode, listNodes, search, upsertNode } from "@/lib/gbrain";
import { amendPendingLinkUpdate, deliverChangeSet, getChangeSet, listChangeSets, proposeChanges } from "@/lib/changes";
import { proposeRestoreNode } from "@/lib/changes/restore";
import type { Viewer } from "@/lib/auth";

/** Versioning against the real database. Opt-in: GBRAIN_DB_TESTS=1 npx vitest run src/lib/changes/versioning.db.test.ts */
const enabled = !!process.env.GBRAIN_DB_TESTS;
let hh: string;
let mum: Viewer, dad: Viewer;
const me = () => ({ activity: "manual_edit" as const, agentType: "user" as const, agentId: mum.id, confidence: 1 });

describe.skipIf(!enabled)("versioning (database)", () => {
  beforeAll(async () => {
    const [h] = await db.insert(households).values({ name: "versioning-check" }).returning(); hh = h.id;
    const [m] = await db.insert(users).values({ householdId: hh, email: `m${Date.now()}@x.test`, name: "Mette", role: "owner" }).returning();
    mum = await viewerFor({ id: m.id, householdId: hh, name: "Mette", email: m.email, role: "owner" as const, personNodeId: null }) as unknown as Viewer;
    const [d] = await db.insert(users).values({ householdId: hh, email: `d${Date.now()}@x.test`, name: "Dan", role: "parent" }).returning();
    dad = await viewerFor({ id: d.id, householdId: hh, name: "Dan", email: d.email, role: "parent" as const, personNodeId: null }, mum.graphId) as unknown as Viewer;
  });
  afterAll(async () => { if (hh) await db.delete(households).where(eq(households.id, hh)); await sql.end(); });

  it("an ingest proposal citing a household file is seen by the co-parent; one citing a private file is not", async () => {
    const [open] = await db.insert(sources).values({ householdId: hh, graphId: mum.graphId, ownerId: mum.id, kind: "upload", title: "School letter", visibility: "household" } as never).returning();
    const [priv] = await db.insert(sources).values({ householdId: hh, graphId: mum.graphId, ownerId: mum.id, kind: "upload", title: "Diary", visibility: "private" } as never).returning();
    const a = await proposeChanges(mum, { title: "From the school letter", origin: "ingest", changes: [{ op: "addNode", type: "event", label: "Sports day", receipt: { sourceId: open.id, quote: "Sports day is Friday" } }] });
    const b = await proposeChanges(mum, { title: "From the diary", origin: "ingest", changes: [{ op: "addNode", type: "event", label: "Secret", receipt: { sourceId: priv.id, quote: "secret" } }] });
    const c = await proposeChanges(mum, { title: "From a chat", origin: "chat", changes: [{ op: "addNode", type: "event", label: "Chat thing", receipt: { sourceId: open.id, conversationId: "00000000-0000-0000-0000-000000000001" } }] });
    expect(await getChangeSet(dad, a!.id)).not.toBeNull();
    expect(await getChangeSet(dad, b!.id)).toBeNull();
    expect(await getChangeSet(dad, c!.id)).toBeNull();
    expect(await getChangeSet(mum, b!.id)).not.toBeNull();
    const ids = (await listChangeSets(dad, { status: "draft" })).map((s) => s.id);
    expect(ids).toContain(a!.id); expect(ids).not.toContain(b!.id);
  });

  it("delivering part of a proposal leaves the rest waiting in 'Rest of …', linked both ways", async () => {
    const p = await proposeChanges(mum, { title: "Two people", origin: "person", changes: [{ op: "addNode", type: "person", label: "Kira" }, { op: "addNode", type: "person", label: "Liv" }] });
    const cs = (await getChangeSet(mum, p!.id))!;
    const r = await deliverChangeSet(mum, p!.id, { onlyChangeIds: [cs.changes[0].id] });
    expect(r.ok).toBe(true); expect(r.restId).toBeTruthy();
    const rest = (await getChangeSet(mum, r.restId!))!;
    expect(rest.title).toBe("Rest of Two people");
    expect(rest.status).toBe("draft");
    expect(rest.changes.map((c) => [c.summary, c.included, c.seq])).toEqual([["Liv", true, 1]]);
    expect(rest.restOf?.id).toBe(p!.id);
    expect((await getChangeSet(mum, p!.id))!.restIn?.id).toBe(rest.id);
    expect((await deliverChangeSet(mum, rest.id, {})).ok).toBe(true);
  });

  it("a model op rolls back with the graph when a later op fails", async () => {
    const { node: other } = await upsertNode(mum, { type: "person", label: "Other Olga" }, me());
    const p = await proposeChanges(mum, { title: "New kind and a bad fact", origin: "assistant", changes: [
      { op: "addKind", nodeType: "person", key: "rollback_kind", label: "Rollback kind" },
      { op: "addNode", nodeId: "00000000-0000-4000-8000-0000000000aa", type: "person", kind: "rollback_kind", label: "Rollback person" },
      // A fact with no relation: gbrain refuses it inside the transaction, after the kind and the node were written.
      { op: "addEdge", fromId: "00000000-0000-4000-8000-0000000000aa", toId: other.id, relation: "!!" },
    ] });
    const r = await deliverChangeSet(mum, p!.id);
    expect(r.ok).toBe(false);
    expect(await db.select().from(metaKinds).where(and(eq(metaKinds.householdId, hh), eq(metaKinds.key, "rollback_kind")))).toEqual([]);
    expect((await db.select().from(changeSets).where(eq(changeSets.id, p!.id)))[0].status).toBe("draft");
    expect(await getNode(mum, "00000000-0000-4000-8000-0000000000aa")).toBeNull();
  });

  it("a retired node leaves lists and search but still opens by id, and comes back as a proposal", async () => {
    const { node } = await upsertNode(mum, { type: "person", label: "Retiree Rasmus" }, me());
    const p = await proposeChanges(mum, { title: "Retire", origin: "person", changes: [{ op: "retireNode", nodeId: node.id }] });
    expect((await deliverChangeSet(mum, p!.id)).ok).toBe(true);
    expect((await listNodes(mum, { q: "Retiree" })).map((n) => n.id)).not.toContain(node.id);
    expect((await search(mum, "Retiree Rasmus")).some((h) => h.kind === "node" && h.node?.id === node.id)).toBe(false);
    expect((await getNode(mum, node.id))?.props.retired).toBe(true);
    const r = await proposeRestoreNode(mum, node.id);
    expect(r.ok).toBe(true);
    if (r.ok) expect((await deliverChangeSet(mum, r.changeSetId)).ok).toBe(true);
    expect((await listNodes(mum, { q: "Retiree" })).map((n) => n.id)).toContain(node.id);
  });

  it("a newer cross-graph edit folds into the waiting Update proposal", async () => {
    const { node } = await upsertNode(mum, { type: "person", label: "Linked Lone" }, me());
    const p = await proposeChanges(mum, { title: "Update Linked Lone", origin: "automation", forUserId: mum.id,
      evidence: { locator: { kind: "cross-graph-link", identityId: "id-1" } } as never,
      changes: [{ op: "updateNode", nodeId: node.id, set: { props: { phone: "1" } } }] });
    const before = (await getChangeSet(mum, p!.id))!.fingerprint;
    const folded = await amendPendingLinkUpdate(mum, { identityId: "id-1", nodeId: node.id, set: { props: { email: "l@x.dk" } } });
    expect(folded).toBe(p!.id);
    const after = (await getChangeSet(mum, p!.id))!;
    expect(after.changes[0].payload.set).toEqual({ props: { phone: "1", email: "l@x.dk" } });
    expect(after.fingerprint).not.toBe(before);
    expect(await amendPendingLinkUpdate(mum, { identityId: "id-2", nodeId: node.id, set: { label: "x" } })).toBeNull();
  });
  it("two documents propose the same topic: the second connects to the first's node, keeps its evidence, and adds no duplicates", async () => {
    const [srcA] = await db.insert(sources).values({ householdId: hh, graphId: mum.graphId, ownerId: mum.id, kind: "upload", title: "ADR-Governance.pdf", visibility: "household" } as never).returning();
    const [srcB] = await db.insert(sources).values({ householdId: hh, graphId: mum.graphId, ownerId: mum.id, kind: "upload", title: "Konvention 16.docx", visibility: "household" } as never).returning();
    const { node: doc } = await upsertNode(mum, { type: "document", label: "Konvention 16" }, me());
    const ops = (sourceId: string, quote: string) => [
      { op: "addNode" as const, type: "topic", label: "BEK 260 remap", receipt: { sourceId, quote } },
      { op: "addNode" as const, type: "topic", label: "§16 remap", receipt: { sourceId, quote } },
      { op: "addEdge" as const, fromId: "", toId: "", relation: "regulates", receipt: { sourceId, quote } },
      { op: "addEdge" as const, fromId: doc.id, toId: "", relation: "mentions", receipt: { sourceId, quote } },
    ];
    const propose = async (title: string, sourceId: string, quote: string) => {
      const ids = ["00000000-0000-4000-8000-", "00000000-0000-4000-9000-"].map((p) => `${p}${Math.random().toString(16).slice(2, 14).padEnd(12, "0")}`);
      const o = ops(sourceId, quote);
      Object.assign(o[0], { nodeId: ids[0] }); Object.assign(o[1], { nodeId: ids[1] });
      Object.assign(o[2], { fromId: ids[0], toId: ids[1] }); Object.assign(o[3], { toId: ids[0] });
      return (await proposeChanges(mum, { title, origin: "ingest", evidence: { sourceId }, changes: o }))!;
    };
    const a = await propose("From ADR", srcA.id, "BEK 260 regulates §16");
    const b = await propose("From Konvention 16", srcB.id, "BEK 260 again");
    expect((await deliverChangeSet(mum, a.id)).ok).toBe(true);

    const second = (await getChangeSet(mum, b.id))!;
    expect(second.summary).toMatchObject({ exists: 2, needsYou: 0, deliverable: true });
    expect(Object.values(second.verdicts)).toEqual(["exists", "exists", "landed", "landed"]);
    expect(second.groups?.[0]).toMatchObject({ code: "exists", origin: { changeSetTitle: "From ADR", sourceTitle: "ADR-Governance.pdf" } });

    const r = await deliverChangeSet(mum, b.id, { fingerprint: second.fingerprint ?? undefined });
    expect(r).toMatchObject({ ok: true, connected: 2 });
    const bek = await db.select().from(nodes).where(and(eq(nodes.graphId, mum.graphId), eq(nodes.label, "BEK 260 remap")));
    expect(bek).toHaveLength(1);
    const facts = await db.select().from(edges).where(and(eq(edges.graphId, mum.graphId), eq(edges.fromId, bek[0].id), eq(edges.relation, "regulates")));
    expect(facts).toHaveLength(1);
    // The second document is evidence on the node and on the fact that was already true.
    const nodeProv = await db.select().from(provenance).where(eq(provenance.subjectId, bek[0].id));
    expect(nodeProv.map((p) => p.sourceId)).toEqual(expect.arrayContaining([srcA.id, srcB.id]));
    expect((await db.select().from(provenance).where(eq(provenance.subjectId, facts[0].id))).map((p) => p.sourceId)).toEqual(expect.arrayContaining([srcA.id, srcB.id]));
    const delivered = (await getChangeSet(mum, b.id))!;
    expect(delivered.remapped?.map((x) => x.to)).toContain(bek[0].id);
  });
});
