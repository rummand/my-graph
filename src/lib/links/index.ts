/**
 * Cross-graph objects ("You can choose the people object to go across graphs into one collective object"): the one
 * explicit, permitted crossing between graphs. Every graph keeps its own node; an identity says "these nodes are the
 * same person". The rules are in ./pure.ts:
 *  - only a member of both graphs (who can read the node on the other side) sees a link;
 *  - sharing copies only the chosen fields, as a change set in the target graph that its members deliver;
 *  - a change on one side becomes a proposal on the others (onNodeChanged), never a silent write;
 *  - unlinking is always possible and leaves every copy as a normal node.
 * Every link, share and unlink is recorded in graph_events of each graph involved (subjectType "link").
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { graphEvents, nodeIdentities, nodeIdentityMembers, nodes, users } from "@/db/schema";
import type { Viewer } from "@/lib/auth";
import { GBrainError, getNode, isUuid, listNodes, readableNodeIds, upsertNode, type GNode, type NodeType, type Visibility } from "@/lib/gbrain";
import { scopeOf } from "@/lib/graphs/pure";
import { graphsOfUser, toContext, type MyGraph } from "@/lib/graphs/store";
import { abandonChangeSet, amendPendingLinkUpdate, getChangeSet, proposeChanges, remembering } from "@/lib/changes";
import { getMeta } from "@/lib/meta";
import { getT, tFor, type TFn } from "@/lib/i18n";
import {
  allowedFields, afterUnlink, pickFields, shareableFields, shareTargets, visibleOthers,
  type AttrLite, type FieldKey, type FieldOption, type MemberRow,
} from "./pure";
import { propagateChange, type PropagationResult } from "./propagate";

export * from "./pure";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type LinkGraph = { id: string; name: string; color: number; kind: string; canWrite: boolean };

export type LinkedCopy = {
  memberId: string; graphId: string; graphName: string; color: number; nodeId: string; label: string | null;
  status: "active" | "pending"; changeSetId: string | null; canUnlink: boolean; fields: FieldKey[];
};

/** What the "Also in" section needs. Null when the viewer has no other graph (the section isn't shown at all). */
export type AlsoIn = {
  nodeId: string; nodeLabel: string; nodeType: string;
  linked: LinkedCopy[];
  shareTargets: LinkGraph[];
  connectGraphs: LinkGraph[];
  fields: FieldOption[];
  canWriteHere: boolean;
};

/* ── Helpers ─────────────────────────────────────────────────────────────────────────────────────────── */

async function translator(): Promise<TFn> {
  try { return await getT(); } catch { return tFor("en"); }
}

/** The same person working in graph `g`, without side effects (no self node is created). */
function viewerIn(v: Viewer, g: MyGraph): Viewer {
  return { ...v, ...toContext(g, g.myRole), personNodeId: null };
}

function asLinkGraph(v: Viewer, g: MyGraph): LinkGraph {
  return { id: g.id, name: g.name, color: g.color, kind: g.kind, canWrite: scopeOf(viewerIn(v, g)).canWrite };
}

function memberRow(r: typeof nodeIdentityMembers.$inferSelect): MemberRow & { linkedBy: string | null } {
  return { id: r.id, identityId: r.identityId, graphId: r.graphId, nodeId: r.nodeId, status: r.status, shareFields: r.shareFields ?? [], changeSetId: r.changeSetId, linkedBy: r.linkedBy };
}

async function membersOfIdentity(identityId: string, ex: typeof db | Tx = db) {
  return (await ex.select().from(nodeIdentityMembers).where(eq(nodeIdentityMembers.identityId, identityId))).map(memberRow);
}

/**
 * Pending shares whose copy now exists in its graph (the share's change set was delivered) become active. Existence in
 * that graph is the test, not the caller's access, so a change made by someone who can't read the copy still travels.
 */
async function activateDelivered<M extends { id: string; nodeId: string; graphId: string; status: string }>(members: M[]): Promise<M[]> {
  const pending = members.filter((m) => m.status === "pending");
  if (!pending.length) return members;
  const there = await db.select({ id: nodes.id, graphId: nodes.graphId }).from(nodes)
    .where(and(inArray(nodes.id, pending.map((m) => m.nodeId)), isNull(nodes.mergedInto)));
  const live = new Set(there.map((n) => `${n.graphId}:${n.id}`));
  for (const m of pending) {
    if (!live.has(`${m.graphId}:${m.nodeId}`)) continue;
    await db.update(nodeIdentityMembers).set({ status: "active" }).where(eq(nodeIdentityMembers.id, m.id));
    m.status = "active";
  }
  return members;
}

async function memberOfNode(nodeId: string, ex: typeof db | Tx = db) {
  const [r] = await ex.select().from(nodeIdentityMembers).where(eq(nodeIdentityMembers.nodeId, nodeId)).limit(1);
  return r ? memberRow(r) : null;
}

async function attrsFor(v: Viewer, n: Pick<GNode, "type" | "kind">): Promise<AttrLite[]> {
  try {
    const meta = await getMeta(v);
    return meta.attributesFor(n.type, n.kind).map((a) => ({ key: a.key, label: a.label, dataType: a.dataType, sensitive: a.sensitive }));
  } catch { return []; }
}

/** The fields a person may pick for this node, with the kind shown by its name in this graph's ontology. */
async function fieldOptions(v: Viewer, node: GNode, t: TFn): Promise<FieldOption[]> {
  const options = shareableFields(node, await attrsFor(v, node), fieldLabels(t));
  const kindLabel = node.kind ? await getMeta(v).then((m) => m.kind(node.type, node.kind)?.label).catch(() => undefined) : undefined;
  return kindLabel ? options.map((o) => (o.key === "kind" ? { ...o, preview: kindLabel } : o)) : options;
}

function fieldLabels(t: TFn) {
  return { label: t("links.fields.label"), kind: t("links.fields.kind"), aliases: t("links.fields.aliases"), summary: t("links.fields.summary") };
}

async function record(tx: Tx | typeof db, e: { graphId: string; identityId: string; nodeId: string; label: string; kind: "linked" | "shared" | "unlinked"; v: Viewer; context: string; otherGraphIds: string[]; changeSetId?: string | null }) {
  // subjectType "link": kept out of the node's own history; toValue carries the graphs so a history view can show
  // it only to people who are members of all of them.
  await tx.insert(graphEvents).values({
    graphId: e.graphId, subjectType: "link", subjectId: e.identityId, subjectName: e.label, kind: e.kind, field: "identity",
    toValue: { nodeId: e.nodeId, otherGraphIds: e.otherGraphIds }, fromNodeId: e.nodeId,
    actorKind: "person", actorId: e.v.id, actorName: e.v.name, changeSetId: e.changeSetId ?? null, context: e.context,
  });
}

async function readableSource(v: Viewer, nodeId: string, t: TFn): Promise<GNode> {
  if (!isUuid(nodeId)) throw new GBrainError(404, t("links.error.notFound"));
  const n = await getNode(v, nodeId);
  if (!n) throw new GBrainError(404, t("links.error.notFound"));
  return n;
}

/** Pending shares settle lazily: delivered → active, abandoned → gone. */
async function settlePending(members: (MemberRow & { linkedBy: string | null })[], byGraph: Map<string, Viewer>, readable: Set<string>) {
  for (const m of members) {
    if (m.status !== "pending") continue;
    if (readable.has(m.nodeId)) {
      await db.update(nodeIdentityMembers).set({ status: "active" }).where(eq(nodeIdentityMembers.id, m.id));
      m.status = "active";
      continue;
    }
    const vg = byGraph.get(m.graphId);
    if (!vg || !m.changeSetId) continue;
    const cs = await getChangeSet(vg, m.changeSetId).catch(() => null);
    if (cs?.status === "abandoned" || (cs?.status === "delivered" && !readable.has(m.nodeId))) {
      await db.delete(nodeIdentityMembers).where(eq(nodeIdentityMembers.id, m.id));
      m.status = "gone";
    }
  }
  return members.filter((m) => m.status !== "gone");
}

/* ── Reading ─────────────────────────────────────────────────────────────────────────────────────────── */

/** The "Also in" section for a node in the viewer's current graph. Null when there is nothing to show or offer. */
export async function linksFor(v: Viewer, nodeId: string): Promise<AlsoIn | null> {
  const t = await translator();
  const node = await getNode(v, nodeId).catch(() => null);
  if (!node) return null;
  const mine = await graphsOfUser(v);
  const others = mine.filter((g) => g.id !== v.graphId);
  if (!others.length) return null;
  const byGraph = new Map(mine.map((g) => [g.id, viewerIn(v, g)] as const));
  const graphById = new Map(mine.map((g) => [g.id, g] as const));

  const me = await memberOfNode(node.id);
  let linked: LinkedCopy[] = [];
  if (me && me.graphId === v.graphId) {
    let members = await membersOfIdentity(me.identityId);
    // Access check per graph, as the viewer working in that graph.
    const readable = new Set<string>([node.id]);
    for (const [gid, vg] of byGraph) {
      if (gid === v.graphId) continue;
      const ids = members.filter((m) => m.graphId === gid).map((m) => m.nodeId);
      if (ids.length) for (const id of await readableNodeIds(vg, ids)) readable.add(id);
    }
    members = await settlePending(members, byGraph, readable);
    const visible = visibleOthers(members, { nodeId: node.id, myGraphIds: new Set(mine.map((g) => g.id)), readable });
    const labels = new Map<string, string>();
    for (const m of visible) {
      if (m.status !== "active") continue;
      const n = await getNode(byGraph.get(m.graphId)!, m.nodeId).catch(() => null);
      if (n) labels.set(m.nodeId, n.label);
    }
    linked = visible.map((m) => {
      const g = graphById.get(m.graphId)!;
      return {
        memberId: m.id, graphId: m.graphId, graphName: g.name, color: g.color, nodeId: m.nodeId, label: labels.get(m.nodeId) ?? null,
        status: m.status === "pending" ? "pending" : "active", changeSetId: m.changeSetId,
        canUnlink: scopeOf(byGraph.get(m.graphId)!).canWrite || scopeOf(v).canWrite, fields: m.shareFields,
      };
    });
  }

  const linkGraphs = others.map((g) => asLinkGraph(v, g));
  const linkedGraphIds = new Set(linked.map((l) => l.graphId));
  return {
    nodeId: node.id, nodeLabel: node.label, nodeType: node.type,
    linked,
    shareTargets: shareTargets(linkGraphs, { currentGraphId: v.graphId, linkedGraphIds }),
    connectGraphs: linkGraphs.filter((g) => !linkedGraphIds.has(g.id) && g.canWrite),
    fields: await fieldOptions(v, node, t),
    canWriteHere: scopeOf(v).canWrite,
  };
}

/** Typeahead for "Connect with…": nodes of the same type in my other graphs that I can read there. */
export async function connectCandidates(v: Viewer, p: { nodeId: string; q?: string; graphId?: string; limit?: number }) {
  const t = await translator();
  const node = await readableSource(v, p.nodeId, t);
  const mine = (await graphsOfUser(v)).filter((g) => g.id !== v.graphId && (!p.graphId || g.id === p.graphId));
  const me = await memberOfNode(node.id);
  const sameIdentity = new Set(me ? (await membersOfIdentity(me.identityId)).map((m) => m.nodeId) : []);
  const q = p.q?.trim() || node.label;
  const out: { graphId: string; graphName: string; color: number; node: { id: string; label: string; type: string; kind: string | null; summary: string | null }; linkedElsewhere: boolean }[] = [];
  for (const g of mine) {
    const vg = viewerIn(v, g);
    if (!scopeOf(vg).canWrite) continue;
    const hits = await listNodes(vg, { type: node.type as NodeType, q, limit: p.limit ?? 8 }).catch(() => []);
    const ids = hits.map((h) => h.id).filter((id) => !sameIdentity.has(id));
    if (!ids.length) continue;
    const taken = new Set((await db.select({ nodeId: nodeIdentityMembers.nodeId }).from(nodeIdentityMembers).where(inArray(nodeIdentityMembers.nodeId, ids))).map((r) => r.nodeId));
    for (const h of hits) {
      if (sameIdentity.has(h.id)) continue;
      out.push({ graphId: g.id, graphName: g.name, color: g.color, node: { id: h.id, label: h.label, type: h.type, kind: h.kind ?? null, summary: h.summary }, linkedElsewhere: taken.has(h.id) });
    }
  }
  return out.slice(0, 20);
}

/* ── Sharing ─────────────────────────────────────────────────────────────────────────────────────────── */

export type ShareResult = { status: "proposed" | "created"; graphId: string; graphName: string; nodeId: string; changeSetId: string | null };

/**
 * "Share with another graph": a copy with only the chosen fields, proposed as a change set in the target graph.
 * Once delivered the copy is linked (pending until then). Never carries facts, sources, provenance or memories.
 */
export async function shareNode(v: Viewer, p: { nodeId: string; graphId: string; fields: FieldKey[]; visibility?: Visibility }): Promise<ShareResult> {
  const t = await translator();
  const node = await readableSource(v, p.nodeId, t);
  if (!scopeOf(v).canWrite) throw new GBrainError(403, t("links.error.cantWriteHere"));
  if (p.graphId === v.graphId) throw new GBrainError(400, t("links.error.sameGraph"));
  const target = (await graphsOfUser(v)).find((g) => g.id === p.graphId);
  if (!target) throw new GBrainError(404, t("links.error.notMember"));
  const vt = viewerIn(v, target);
  if (!scopeOf(vt).canWrite) throw new GBrainError(403, t("links.error.cantWrite", { graph: target.name }));

  const me = await memberOfNode(node.id);
  if (me) {
    const existing = await membersOfIdentity(me.identityId);
    if (existing.some((m) => m.graphId === target.id)) throw new GBrainError(409, t("links.error.already", { graph: target.name }));
  }

  const options = await fieldOptions(v, node, t);
  const fields = allowedFields(p.fields, options);
  const payload = pickFields(node, fields);
  // The target graph's own ontology decides which kinds and attributes it knows.
  const tmeta = await getMeta(vt).catch(() => null);
  const kind = payload.kind && tmeta?.kind(node.type, payload.kind) ? payload.kind : null;
  const known = new Set((tmeta?.attributesFor(node.type, kind) ?? []).map((a) => a.key));
  const props = Object.fromEntries(Object.entries(payload.props).filter(([k]) => known.has(k)));
  const visibility = p.visibility ?? "household";
  const fieldNames = options.filter((o) => fields.includes(o.key)).map((o) => o.label).join(", ");
  const receiptText = t("links.cs.shareReceipt", { graph: v.graphName, who: v.name });

  const proposal = await proposeChanges(vt, {
    title: t("links.cs.shareTitle", { name: node.label, graph: v.graphName }),
    description: t("links.cs.shareDescription", { who: v.name, name: node.label, graph: v.graphName, fields: fieldNames }),
    origin: "person",
    evidence: { quote: receiptText, locator: { kind: "cross-graph-share", fields } },
    changes: [{
      op: "addNode", type: node.type, kind, label: payload.label, summary: payload.summary, props, aliases: payload.aliases, visibility,
      note: receiptText, receipt: { quote: receiptText, locator: { kind: "cross-graph-share", fields }, confidence: 1 },
    }],
  }).catch((e) => { console.error("[links] proposeChanges failed", e); return null; });

  if (proposal) {
    const newId = proposal.nodeIds[0] ?? Object.values(proposal.nodeIds)[0];
    if (newId) {
      await linkInto(v, { source: node, sourceGraphId: v.graphId, fields, target: { graphId: target.id, nodeId: newId, status: "pending", changeSetId: proposal.id }, kind: "shared", t });
    }
    return { status: "proposed", graphId: target.id, graphName: target.name, nodeId: newId ?? "", changeSetId: proposal.id };
  }

  // VERSIONING FALLBACK: until src/lib/changes lands (proposeChanges returns null), the person's own explicit share
  // is written straight through gbrain, with provenance "shared from <graph> by <you>", and linked. Remove this branch
  // once change sets are live; the proposal path above then covers every share.
  const { node: created } = await remembering(vt, { actorKind: "person", actorName: v.name, context: receiptText }, () => upsertNode(vt, {
    type: node.type, kind, label: payload.label, aliases: payload.aliases, summary: payload.summary, props, visibility, sensitive: node.sensitive,
  }, { activity: "import", agentType: "user", agentId: v.id, confidence: 1, quote: receiptText, note: receiptText }));
  const taken = await memberOfNode(created.id);
  if (taken && taken.identityId !== me?.identityId) throw new GBrainError(409, t("links.error.already", { graph: target.name }));
  if (!taken) await linkInto(v, { source: node, sourceGraphId: v.graphId, fields, target: { graphId: target.id, nodeId: created.id, status: "active", changeSetId: null }, kind: "shared", t });
  return { status: "created", graphId: target.id, graphName: target.name, nodeId: created.id, changeSetId: null };
}

/** Puts `target` into the source node's identity (creating it), recording the event in both graphs. */
async function linkInto(v: Viewer, p: {
  source: GNode; sourceGraphId: string; fields: FieldKey[];
  target: { graphId: string; nodeId: string; status: "active" | "pending"; changeSetId: string | null; fields?: FieldKey[] };
  kind: "linked" | "shared"; t: TFn;
}) {
  await db.transaction(async (tx) => {
    const [cur] = await tx.select().from(nodeIdentityMembers).where(eq(nodeIdentityMembers.nodeId, p.source.id)).for("update");
    let identityId = cur?.identityId;
    if (!identityId) {
      [{ id: identityId }] = await tx.insert(nodeIdentities).values({ createdBy: v.id }).returning({ id: nodeIdentities.id });
      await tx.insert(nodeIdentityMembers).values({ identityId, graphId: p.sourceGraphId, nodeId: p.source.id, shareFields: p.fields, linkedBy: v.id });
    } else {
      const merged = [...new Set([...(cur.shareFields ?? []), ...p.fields])];
      await tx.update(nodeIdentityMembers).set({ shareFields: merged }).where(eq(nodeIdentityMembers.id, cur.id));
    }
    await tx.insert(nodeIdentityMembers).values({
      identityId, graphId: p.target.graphId, nodeId: p.target.nodeId, shareFields: p.target.fields ?? p.fields,
      status: p.target.status, changeSetId: p.target.changeSetId, linkedBy: v.id,
    });
    const context = p.kind === "shared" ? p.t("links.event.shared") : p.t("links.event.linked", { type: p.source.type });
    await record(tx, { graphId: p.sourceGraphId, identityId, nodeId: p.source.id, label: p.source.label, kind: p.kind, v, context, otherGraphIds: [p.target.graphId], changeSetId: p.target.changeSetId });
    await record(tx, { graphId: p.target.graphId, identityId, nodeId: p.target.nodeId, label: p.source.label, kind: p.kind, v, context, otherGraphIds: [p.sourceGraphId], changeSetId: p.target.changeSetId });
  });
}

/* ── Connecting ──────────────────────────────────────────────────────────────────────────────────────── */

/** "Connect with…": the node here and an existing node in another of my graphs are the same identity (both ways). */
export async function connectNodes(v: Viewer, p: { nodeId: string; otherGraphId: string; otherNodeId: string; fields?: FieldKey[] }): Promise<{ graphId: string; graphName: string }> {
  const t = await translator();
  const node = await readableSource(v, p.nodeId, t);
  if (!scopeOf(v).canWrite) throw new GBrainError(403, t("links.error.cantWriteHere"));
  if (p.otherGraphId === v.graphId) throw new GBrainError(400, t("links.error.sameGraph"));
  const g = (await graphsOfUser(v)).find((x) => x.id === p.otherGraphId);
  if (!g) throw new GBrainError(404, t("links.error.notMember"));
  const vo = viewerIn(v, g);
  if (!scopeOf(vo).canWrite) throw new GBrainError(403, t("links.error.cantWrite", { graph: g.name }));
  const other = isUuid(p.otherNodeId) ? await getNode(vo, p.otherNodeId) : null;
  if (!other) throw new GBrainError(404, t("links.error.notFound"));
  if (other.type !== node.type) throw new GBrainError(400, t("links.error.sameType"));

  const options = await fieldOptions(v, node, t);
  const fields = allowedFields(p.fields ?? options.filter((o) => o.defaultOn).map((o) => o.key), options);

  await db.transaction(async (tx) => {
    const [a] = await tx.select().from(nodeIdentityMembers).where(eq(nodeIdentityMembers.nodeId, node.id)).for("update");
    const [b] = await tx.select().from(nodeIdentityMembers).where(eq(nodeIdentityMembers.nodeId, other.id)).for("update");
    if (a && b && a.identityId === b.identityId) throw new GBrainError(409, t("links.error.alreadyLinked"));
    let identityId: string;
    if (a && b) {
      const ma = await membersOfIdentity(a.identityId, tx), mb = await membersOfIdentity(b.identityId, tx);
      const ga = new Set(ma.map((m) => m.graphId));
      if (mb.some((m) => ga.has(m.graphId))) throw new GBrainError(409, t("links.error.conflict"));
      await tx.update(nodeIdentityMembers).set({ identityId: a.identityId }).where(eq(nodeIdentityMembers.identityId, b.identityId));
      await tx.delete(nodeIdentities).where(eq(nodeIdentities.id, b.identityId));
      identityId = a.identityId;
    } else if (a || b) {
      const existing = (a ?? b)!;
      const ms = await membersOfIdentity(existing.identityId, tx);
      const joinGraph = a ? g.id : v.graphId;
      if (ms.some((m) => m.graphId === joinGraph)) throw new GBrainError(409, t("links.error.already", { graph: a ? g.name : v.graphName }));
      identityId = existing.identityId;
      await tx.insert(nodeIdentityMembers).values({ identityId, graphId: joinGraph, nodeId: a ? other.id : node.id, shareFields: fields, linkedBy: v.id });
    } else {
      [{ id: identityId }] = await tx.insert(nodeIdentities).values({ createdBy: v.id }).returning({ id: nodeIdentities.id });
      await tx.insert(nodeIdentityMembers).values([
        { identityId, graphId: v.graphId, nodeId: node.id, shareFields: fields, linkedBy: v.id },
        { identityId, graphId: g.id, nodeId: other.id, shareFields: fields, linkedBy: v.id },
      ]);
    }
    const context = t("links.event.linked", { type: node.type });
    await record(tx, { graphId: v.graphId, identityId, nodeId: node.id, label: node.label, kind: "linked", v, context, otherGraphIds: [g.id] });
    await record(tx, { graphId: g.id, identityId, nodeId: other.id, label: other.label, kind: "linked", v, context, otherGraphIds: [v.graphId] });
  });
  return { graphId: g.id, graphName: g.name };
}

/* ── Unlinking ───────────────────────────────────────────────────────────────────────────────────────── */

/**
 * Unlink: with `otherNodeId`, takes that graph's copy out of the identity (a pending share is withdrawn: its change
 * set is abandoned); without it, takes this node out. Every copy stays a normal node. An identity left with one
 * member dissolves.
 */
export async function unlinkNode(v: Viewer, p: { nodeId: string; otherNodeId?: string }): Promise<{ dissolved: boolean }> {
  const t = await translator();
  const node = await readableSource(v, p.nodeId, t);
  const me = await memberOfNode(node.id);
  if (!me || me.graphId !== v.graphId) throw new GBrainError(404, t("links.error.notLinked"));
  const mine = await graphsOfUser(v);
  const byGraph = new Map(mine.map((g) => [g.id, viewerIn(v, g)] as const));
  const members = await membersOfIdentity(me.identityId);

  let drop: (MemberRow & { linkedBy: string | null })[];
  if (p.otherNodeId) {
    const readable = new Set<string>([node.id]);
    const target = members.find((m) => m.nodeId === p.otherNodeId);
    const vg = target ? byGraph.get(target.graphId) : undefined;
    if (target && vg) for (const id of await readableNodeIds(vg, [target.nodeId])) readable.add(id);
    const visible = visibleOthers(members, { nodeId: node.id, myGraphIds: new Set(byGraph.keys()), readable });
    if (!target || !vg || !visible.some((m) => m.id === target.id)) throw new GBrainError(404, t("links.error.notFound"));
    if (!scopeOf(vg).canWrite && !scopeOf(v).canWrite) throw new GBrainError(403, t("links.error.cantWriteHere"));
    if (target.status === "pending" && target.changeSetId) await abandonChangeSet(vg, target.changeSetId).catch(() => false);
    drop = [target];
  } else {
    if (!scopeOf(v).canWrite) throw new GBrainError(403, t("links.error.cantWriteHere"));
    drop = [me];
  }
  const { remaining, dissolve } = afterUnlink(members, drop.map((d) => d.nodeId));
  const context = t("links.event.unlinked");
  await db.transaction(async (tx) => {
    await tx.delete(nodeIdentityMembers).where(inArray(nodeIdentityMembers.id, drop.map((d) => d.id)));
    if (dissolve) await tx.delete(nodeIdentities).where(eq(nodeIdentities.id, me.identityId));
    const touched = dissolve ? members : [...drop, ...remaining.filter((m) => m.nodeId === node.id)];
    for (const m of touched) {
      const others = members.filter((x) => x.graphId !== m.graphId).map((x) => x.graphId);
      await record(tx, { graphId: m.graphId, identityId: me.identityId, nodeId: m.nodeId, label: node.label, kind: "unlinked", v, context, otherGraphIds: others });
    }
  });
  return { dissolved: dissolve };
}

/* ── Propagation ─────────────────────────────────────────────────────────────────────────────────────── */

/**
 * Call after a node's fields changed (the versioning workstream/integrator calls this from `remembering` after an
 * update or a delivered change set). For every linked copy whose agreed fields moved, a change set is opened in that
 * graph, waiting for a person who is a member of both graphs. Nothing is written to the other graph here.
 * `changedFields` uses the keys of ./pure ("label", "kind", "aliases", "summary", "props.<key>"); see changedFieldKeys.
 */
export async function onNodeChanged(v: Viewer, nodeId: string, changedFields: FieldKey[]): Promise<PropagationResult> {
  if (!isUuid(nodeId) || !changedFields.length) return { proposed: [], skipped: 0 };
  const found = await memberOfNode(nodeId).catch(() => null);
  const me = found ? (await activateDelivered([found]))[0] : null;
  if (!me || me.status !== "active" || me.graphId !== v.graphId) return { proposed: [], skipped: 0 };
  const t = await translator();
  const myGraphs = await graphsOfUser(v);
  const viewers = new Map<string, Viewer>(); // `${userId}:${graphId}` → viewer working there
  const graphsOf = new Map<string, MyGraph[]>([[v.id, myGraphs]]);

  async function viewerOf(userId: string, graphId: string): Promise<Viewer | null> {
    const key = `${userId}:${graphId}`;
    if (viewers.has(key)) return viewers.get(key)!;
    let row: Omit<Viewer, keyof ReturnType<typeof toContext>> | null = userId === v.id ? v : null;
    if (!row) {
      const [u] = await db.select({ id: users.id, householdId: users.householdId, name: users.name, email: users.email, role: users.role, personNodeId: users.personNodeId })
        .from(users).where(eq(users.id, userId));
      if (!u) return null;
      row = u;
    }
    if (!graphsOf.has(userId)) graphsOf.set(userId, await graphsOfUser(row));
    const g = graphsOf.get(userId)!.find((x) => x.id === graphId);
    const out: Viewer | null = g ? { ...row, ...toContext(g, g.myRole), personNodeId: null } : null;
    if (out) viewers.set(key, out);
    return out;
  }

  const nameOf = (f: string) => f.startsWith("props.") ? f.slice(6) : t(`links.fields.${f}`);
  const fieldsOf = (set: Record<string, unknown>) => Object.entries(set).flatMap(([k, x]) => k === "props" && x && typeof x === "object" ? Object.keys(x).map((pk) => `props.${pk}`) : [k]);

  return propagateChange({
    othersOf: async () => (await activateDelivered(await membersOfIdentity(me.identityId))).filter((m) => m.nodeId !== nodeId && m.status === "active"),
    source: async () => {
      const n = await getNode(v, nodeId);
      return n ? { graphId: v.graphId, node: n, shareFields: me.shareFields } : null;
    },
    proposerIn: async (graphId, linkedBy) => {
      // Only someone in both graphs proposes (and is who the change set waits for), so nobody else learns of the link.
      const mineThere = await viewerOf(v.id, graphId);
      if (mineThere && scopeOf(mineThere).canWrite) return v.id;
      if (!linkedBy || linkedBy === v.id) return null;
      const there = await viewerOf(linkedBy, graphId);
      const here = await viewerOf(linkedBy, v.graphId);
      return there && here && scopeOf(there).canWrite ? linkedBy : null;
    },
    targetNode: async (proposerId, graphId, otherId) => {
      const vp = await viewerOf(proposerId, graphId);
      return vp ? getNode(vp, otherId) : null;
    },
    amend: async (proposerId, graphId, p) => {
      const vp = await viewerOf(proposerId, graphId);
      if (!vp) return null;
      return amendPendingLinkUpdate(vp, {
        identityId: me.identityId, nodeId: p.nodeId, set: p.set, title: t("links.cs.updateTitle", { name: p.label }),
        note: (merged) => t("links.cs.updateNote", { fields: fieldsOf(merged).map(nameOf).join(", ") }),
      }).catch((e) => { console.error("[links] could not fold into the waiting proposal", e); return null; });
    },
    propose: async (proposerId, graphId, p) => {
      const vp = await viewerOf(proposerId, graphId);
      if (!vp) return null;
      const names = p.fields.map(nameOf).join(", ");
      const res = await proposeChanges(vp, {
        title: t("links.cs.updateTitle", { name: p.label }),
        origin: "automation", forUserId: proposerId,
        evidence: { locator: { kind: "cross-graph-link", identityId: me.identityId } },
        changes: [{ op: "updateNode", nodeId: p.nodeId, set: p.set, note: t("links.cs.updateNote", { fields: names }), receipt: { confidence: 1, locator: { kind: "cross-graph-link" } } }],
      }).catch((e) => { console.error("[links] proposal failed", e); return null; });
      return res?.id ?? null;
    },
  }, nodeId, changedFields);
}
