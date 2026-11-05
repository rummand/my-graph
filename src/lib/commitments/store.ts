/**
 * Reading commitments (server-only). Everything is scoped to the viewer's current graph and filtered by GBrain's own
 * access rules: a commitment shows only when its node is readable (nodeReadSql), each party only when that node and
 * the edge are readable, and each source only when the viewer may open it (sourceVisibleTo). Nothing here writes.
 */
import { and, eq, inArray, isNull, notInArray, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { edges, nodes, provenance, reminders, sources } from "@/db/schema";
import type { Viewer } from "@/lib/auth";
import { accessContext } from "@/lib/gbrain";
import { edgeSelfReadSql, liveNodeSql, nodeEditSql, nodeReadSql } from "@/lib/gbrain/access";
import { sourceVisibleTo } from "@/lib/ingest/access";
import { readProps, type CommitmentSource, type CommitmentView, type Party } from "./pure";
import { COMMITMENT_RELATIONS, type CommitmentStatus } from "./types";

const R = COMMITMENT_RELATIONS;
const RELATIONS = [R.responsible, R.with, R.about, R.arisesFrom, R.clashesWith];
const MAX = 800;

export type LoadOpts = {
  ids?: string[];
  status?: CommitmentStatus[] | "all";
  /** Only these where this person is responsible, the other party, or what it is about. */
  personId?: string | null;
  limit?: number;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Commitments the viewer may read in their current graph, with parties, sources and the linked reminder. */
export async function loadCommitments(v: Viewer, opts: LoadOpts = {}): Promise<CommitmentView[]> {
  if (!v.graphId) return [];
  const ctx = await accessContext(v);
  if (!ctx.active) return [];
  const ids = opts.ids?.filter((x) => UUID.test(x));
  if (opts.ids && !ids?.length) return [];
  const statuses = opts.status === "all" || !opts.status ? null : opts.status;
  const rows = await db.select({
    id: nodes.id, label: nodes.label, summary: nodes.summary, props: nodes.props, kind: nodes.kind, startAt: nodes.startAt,
    ownerId: nodes.ownerId, visibility: nodes.visibility, sensitive: nodes.sensitive, createdAt: nodes.createdAt, updatedAt: nodes.updatedAt,
    canEdit: sql<boolean>`(${nodeEditSql(ctx, "nodes")})`,
  }).from(nodes).where(and(
    eq(nodes.graphId, v.graphId), eq(nodes.type, "commitment"), isNull(nodes.mergedInto), liveNodeSql("nodes"), nodeReadSql(ctx, "nodes"),
    ids ? inArray(nodes.id, ids) : undefined,
    statuses ? sql`coalesce(${nodes.props}->>'status', 'open') in (${sql.join(statuses.map((s) => sql`${s}`), sql`, `)})` : undefined,
  )).orderBy(sql`${nodes.startAt} asc nulls last`).limit(Math.min(opts.limit ?? MAX, MAX));
  if (!rows.length) return [];
  const cIds = rows.map((r) => r.id);

  // Facts around them, readable as facts (the edge itself and the node at the other end).
  const other = sql`(case when ${edges.fromId} in (${sql.join(cIds.map((id) => sql`${id}`), sql`, `)}) then ${edges.toId} else ${edges.fromId} end)`;
  const es = await db.select({
    id: edges.id, fromId: edges.fromId, toId: edges.toId, relation: edges.relation,
    otherLabel: nodes.label, otherType: nodes.type, otherId: nodes.id,
  }).from(edges).innerJoin(nodes, sql`${nodes.id} = ${other}`).where(and(
    eq(edges.graphId, v.graphId), inArray(edges.relation, RELATIONS), notInArray(edges.status, ["rejected", "superseded"]),
    or(inArray(edges.fromId, cIds), inArray(edges.toId, cIds)), edgeSelfReadSql(ctx, "edges"),
    isNull(nodes.mergedInto), liveNodeSql("nodes"), nodeReadSql(ctx, "nodes"),
  ));

  // Where they come from: provenance on the commitment node and its arises_from facts, from sources the viewer may open.
  const arisesEdgeIds = es.filter((e) => e.relation === R.arisesFrom).map((e) => e.id);
  const provRows = await db.select({
    subjectId: provenance.subjectId, subjectType: provenance.subjectType, sourceId: provenance.sourceId, chunkId: provenance.chunkId,
    quote: provenance.quote, locator: provenance.locator, title: sources.title, createdAt: provenance.createdAt,
  }).from(provenance).innerJoin(sources, eq(sources.id, provenance.sourceId)).where(and(
    eq(provenance.graphId, v.graphId),
    or(and(eq(provenance.subjectType, "node"), inArray(provenance.subjectId, cIds)), arisesEdgeIds.length ? and(eq(provenance.subjectType, "edge"), inArray(provenance.subjectId, arisesEdgeIds)) : undefined),
    sourceVisibleTo(v),
  ));
  const edgeOwner = new Map(es.map((e) => [e.id, e.fromId]));

  // The reminder that goes with each (linked by node id).
  const rems = await db.select({ id: reminders.id, nodeId: reminders.nodeId, dueAt: reminders.dueAt, done: reminders.done })
    .from(reminders).where(and(eq(reminders.graphId, v.graphId), inArray(reminders.nodeId, cIds)));

  return rows.map((r): CommitmentView => {
    const mine = (rel: string, side: "from" | "to") => es
      .filter((e) => e.relation === rel && (side === "from" ? e.toId === r.id : e.fromId === r.id) && e.otherId !== r.id)
      .map((e): Party => ({ id: e.otherId, label: e.otherLabel, type: e.otherType, edgeId: e.id }));
    const clashes = es.filter((e) => e.relation === R.clashesWith && (e.fromId === r.id || e.toId === r.id) && e.otherId !== r.id)
      .map((e): Party => ({ id: e.otherId, label: e.otherLabel, type: e.otherType, edgeId: e.id }));
    const seen = new Set<string>();
    const srcs: CommitmentSource[] = [];
    for (const p of provRows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
      const owner = p.subjectType === "node" ? p.subjectId : edgeOwner.get(p.subjectId);
      if (owner !== r.id || !p.sourceId) continue;
      const key = `${p.sourceId}:${p.chunkId ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const page = typeof (p.locator as { page?: unknown })?.page === "number" ? (p.locator as { page: number }).page : null;
      srcs.push({
        sourceId: p.sourceId, title: p.title, quote: p.quote, chunkId: p.chunkId, page,
        href: `/library/${p.sourceId}${p.chunkId ? `#chunk-${p.chunkId}${page ? `.p${page}` : ""}${p.quote ? `.q${encodeURIComponent(p.quote.slice(0, 80))}` : ""}` : ""}`,
      });
    }
    const rem = rems.filter((x) => x.nodeId === r.id).sort((a, b) => Number(a.done) - Number(b.done))[0];
    return {
      id: r.id, label: r.label, summary: r.summary, props: readProps(r.props, { startAt: r.startAt, kind: r.kind }),
      ownerId: r.ownerId, visibility: r.visibility, sensitive: r.sensitive,
      responsible: mine(R.responsible, "from"), counterparty: mine(R.with, "to"), about: mine(R.about, "to"), arisesFrom: mine(R.arisesFrom, "to"), clashes,
      sources: srcs.slice(0, 6), reminder: rem ? { id: rem.id, dueAt: rem.dueAt.toISOString(), done: rem.done } : null,
      canEdit: !!r.canEdit, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
    };
  }).filter((c) => !opts.personId || c.responsible.some((p) => p.id === opts.personId) || c.counterparty.some((p) => p.id === opts.personId) || c.about.some((p) => p.id === opts.personId));
}

export async function getCommitment(v: Viewer, id: string): Promise<CommitmentView | null> {
  if (!UUID.test(id)) return null;
  return (await loadCommitments(v, { ids: [id], status: "all" }))[0] ?? null;
}

/** People in the graph the viewer may read (for Reassign and the person filter). */
export async function readablePeople(v: Viewer, limit = 200): Promise<Party[]> {
  const ctx = await accessContext(v);
  const rows = await db.select({ id: nodes.id, label: nodes.label }).from(nodes)
    .where(and(eq(nodes.graphId, v.graphId), eq(nodes.type, "person"), isNull(nodes.mergedInto), liveNodeSql("nodes"), nodeReadSql(ctx, "nodes")))
    .orderBy(nodes.label).limit(limit);
  return rows.map((r) => ({ id: r.id, label: r.label, type: "person" }));
}

/** Whether a source is one the viewer may open (for evidence attached when marking done). */
export async function sourceReadable(v: Viewer, sourceId: string): Promise<boolean> {
  if (!UUID.test(sourceId)) return false;
  const [s] = await db.select({ id: sources.id }).from(sources).where(and(eq(sources.id, sourceId), sourceVisibleTo(v))).limit(1);
  return !!s;
}
