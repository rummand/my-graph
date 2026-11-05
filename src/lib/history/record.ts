/**
 * Writing the graph's history down (server-only). After Nexus lib/history/record.ts: a write is snapshotted before
 * and after, the difference is one `graph_events` row per field, and rapid edits by the same hand fold together.
 * Recording never fails the write: it runs in its own savepoint and a failure is logged, not thrown.
 */
import { and, desc, eq, getTableColumns, gte, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { edges, graphEvents, metaAttributes, metaKinds, metaRelations, metaRoles, nodes } from "@/db/schema";
import { currentScope, type Actor, type Tx } from "./context";
import { coalesce, diffEdge, diffMeta, diffNode, edgeSnap, MOMENT_MS, nodeSnap, sameHand, type EdgeSnap, type EventDraft, type MetaSnap, type NodeSnap } from "./pure";

/** Node columns a snapshot needs: not the search vector or the 1024-float embedding (~12 KB a row as text). */
const { embedding: _embedding, search: _search, ...SNAP_NODE_COLS } = getTableColumns(nodes);

export type Exec = typeof db | Tx;

export type Stamp = { actor: Actor; changeSetId: string | null; context: string | null };

/** The hand on this write: the surrounding remembering()/delivery, else what the caller knows (its provenance). */
export function stampFor(fallback: Partial<Stamp> & { actor: Actor }): Stamp {
  const s = currentScope();
  if (s) return { actor: s.actor, changeSetId: s.changeSetId, context: s.context ?? fallback.context ?? null };
  return { actor: fallback.actor, changeSetId: fallback.changeSetId ?? null, context: fallback.context ?? null };
}

/** Write events, folding each into the one before it when the same hand continues the same field (2 minutes). */
export async function writeEvents(ex: Exec, graphId: string, drafts: EventDraft[], stamp: Stamp): Promise<void> {
  if (!drafts.length) return;
  const now = new Date();
  const cutoff = new Date(now.getTime() - MOMENT_MS);
  const fresh: EventDraft[] = [];
  for (const d of drafts) {
    if (d.kind !== "updated" || !d.field) { fresh.push(d); continue; }
    const [prev] = await ex.select().from(graphEvents)
      .where(and(eq(graphEvents.graphId, graphId), eq(graphEvents.subjectId, d.subjectId), eq(graphEvents.field, d.field), gte(graphEvents.at, cutoff)))
      .orderBy(desc(graphEvents.at)).limit(1);
    const hand = prev && sameHand(prev, { actorKind: stamp.actor.kind, actorId: stamp.actor.id, changeSetId: stamp.changeSetId, context: stamp.context, at: now });
    const folded = hand ? coalesce(prev, d) : { action: "insert" as const };
    if (folded.action === "insert" || !prev) fresh.push(d);
    else if (folded.action === "drop") await ex.delete(graphEvents).where(eq(graphEvents.id, prev.id));
    else await ex.update(graphEvents).set({ fromValue: folded.from as never, toValue: folded.to as never, subjectName: d.subjectName, at: now }).where(eq(graphEvents.id, prev.id));
  }
  if (!fresh.length) return;
  await ex.insert(graphEvents).values(fresh.map((d) => ({
    graphId, subjectType: d.subjectType, subjectId: d.subjectId, subjectName: d.subjectName?.slice(0, 300) ?? null, kind: d.kind, field: d.field,
    fromValue: (d.fromValue ?? null) as never, toValue: (d.toValue ?? null) as never, fromNodeId: d.fromNodeId ?? null, toNodeId: d.toNodeId ?? null,
    actorKind: stamp.actor.kind, actorId: stamp.actor.id, actorName: stamp.actor.name, changeSetId: stamp.changeSetId, context: stamp.context, at: now,
  })));
}

/** Run the recording in its own savepoint so a failure can never abort the write's transaction. */
export async function safely(ex: Exec, what: string, fn: (ex: Exec) => Promise<void>): Promise<void> {
  try {
    await ex.transaction(async (sp) => { await fn(sp); });
  } catch (e) {
    console.error(`[history] the write happened but ${what} was not recorded`, e);
  }
}

/* ── Nodes and facts ─────────────────────────────────────────────────────────────────────────────────── */

export type Scope = { nodeIds?: string[]; edgeIds?: string[] };
export type Snapshot = { nodes: Map<string, NodeSnap>; edges: Map<string, EdgeSnap> };

/** The rows in scope as they are now (no access filter: internal, the caller already decided). */
export async function snapshotScope(ex: Exec, scope: Scope): Promise<Snapshot> {
  const nodeIds = [...new Set(scope.nodeIds ?? [])], edgeIds = [...new Set(scope.edgeIds ?? [])];
  const [n, e] = await Promise.all([
    nodeIds.length ? ex.select(SNAP_NODE_COLS).from(nodes).where(inArray(nodes.id, nodeIds)) : Promise.resolve([]),
    edgeIds.length ? ex.select().from(edges).where(inArray(edges.id, edgeIds)) : Promise.resolve([]),
  ]);
  return { nodes: new Map(n.map((r) => [r.id, nodeSnap(r)])), edges: new Map(e.map((r) => [r.id, edgeSnap(r)])) };
}

/** Names for facts in history lines: "Anna · attends · Ny Skole". */
async function edgeNames(ex: Exec, list: EdgeSnap[]): Promise<Map<string, string>> {
  const ids = [...new Set(list.flatMap((e) => [e.fromId, e.toId]))];
  if (!ids.length) return new Map();
  const rows = await ex.select({ id: nodes.id, label: nodes.label }).from(nodes).where(inArray(nodes.id, ids));
  const label = new Map(rows.map((r) => [r.id, r.label]));
  return new Map(list.map((e) => {
    // A role held: "Lars · doctor · Lægehuset Vejle", or "Lars · doctor" when where isn't known (the edge points back).
    const rel = (e.relation.startsWith("role:") ? e.relation.slice(5) : e.relation).replace(/_/g, " ");
    if (e.relation.startsWith("role:") && e.fromId === e.toId) return [e.id, `${label.get(e.fromId) ?? "?"} · ${rel}`];
    return [e.id, `${label.get(e.fromId) ?? "?"} · ${rel} · ${label.get(e.toId) ?? "?"}`];
  }));
}

/** Diff two snapshots of the same scope and write the events. */
export async function recordSnapshots(ex: Exec, graphId: string, before: Snapshot, after: Snapshot, stamp: Stamp): Promise<void> {
  await safely(ex, "the change", async (sp) => {
    const drafts: EventDraft[] = [];
    for (const id of new Set([...before.nodes.keys(), ...after.nodes.keys()])) drafts.push(...diffNode(before.nodes.get(id) ?? null, after.nodes.get(id) ?? null));
    const edgeIds = [...new Set([...before.edges.keys(), ...after.edges.keys()])];
    const names = await edgeNames(sp, edgeIds.map((id) => (after.edges.get(id) ?? before.edges.get(id))!));
    for (const id of edgeIds) drafts.push(...diffEdge(before.edges.get(id) ?? null, after.edges.get(id) ?? null, names.get(id)));
    await writeEvents(sp, graphId, drafts, stamp);
  });
}

/** For writes that already hold both rows (before from `for update`, after from `returning`). */
export async function recordRows(
  ex: Exec, graphId: string,
  pairs: { nodes?: [NodeSnap | null, NodeSnap | null][]; edges?: [EdgeSnap | null, EdgeSnap | null][] },
  stamp: Stamp,
): Promise<void> {
  const before: Snapshot = { nodes: new Map(), edges: new Map() }, after: Snapshot = { nodes: new Map(), edges: new Map() };
  for (const [b, a] of pairs.nodes ?? []) { if (b) before.nodes.set(b.id, b); if (a) after.nodes.set(a.id, a); }
  for (const [b, a] of pairs.edges ?? []) { if (b) before.edges.set(b.id, b); if (a) after.edges.set(a.id, a); }
  await recordSnapshots(ex, graphId, before, after, stamp);
}

/** One explicit event (a wiki page delivered, a merge noted on the kept node). */
export async function recordEvent(ex: Exec, graphId: string, draft: EventDraft, stamp: Stamp): Promise<void> {
  await safely(ex, "the event", (sp) => writeEvents(sp, graphId, [draft], stamp));
}

/* ── The meta model ──────────────────────────────────────────────────────────────────────────────────── */

/** The graph's own and household-wide model rows (built-ins never change, so they are not watched). */
export async function snapshotMeta(ex: Exec, householdId: string, graphId: string): Promise<Map<string, MetaSnap>> {
  const own = <T extends typeof metaKinds | typeof metaRelations | typeof metaAttributes | typeof metaRoles>(t: T) =>
    and(eq(t.householdId, householdId), or(isNull(t.graphId), eq(t.graphId, graphId)));
  const [k, r, a, ro] = await Promise.all([
    ex.select().from(metaKinds).where(own(metaKinds)),
    ex.select().from(metaRelations).where(own(metaRelations)),
    ex.select().from(metaAttributes).where(own(metaAttributes)),
    ex.select().from(metaRoles).where(own(metaRoles)),
  ]);
  const out = new Map<string, MetaSnap>();
  for (const x of k) out.set(x.id, { id: x.id, table: "kinds", key: x.key, label: x.label, nodeType: x.nodeType, pluralLabel: x.pluralLabel, description: x.description, parentKey: x.parentKey, circle: x.circle, status: x.status, hidden: x.builtin });
  for (const x of r) out.set(x.id, { id: x.id, table: "relations", key: x.key, label: x.label, inverseLabel: x.inverseLabel, category: x.category, fromTypes: x.fromTypes, toTypes: x.toTypes, symmetric: x.symmetric, status: x.status, hidden: x.builtin });
  for (const x of ro) out.set(x.id, { id: x.id, table: "roles", key: x.key, label: x.label, pluralLabel: x.pluralLabel, preposition: x.preposition, labelDa: x.labelDa, circle: x.circle, contextTypes: x.contextTypes, parentKey: x.parentKey, status: x.status, hidden: x.builtin });
  for (const x of a) out.set(x.id, { id: x.id, table: "attributes", key: x.key, label: x.label, nodeType: x.nodeType, kindKey: x.kindKey, dataType: x.dataType, options: x.options, sensitive: x.sensitive, status: x.status, hidden: x.builtin });
  return out;
}

export async function recordMeta(ex: Exec, graphId: string, before: Map<string, MetaSnap>, after: Map<string, MetaSnap>, stamp: Stamp): Promise<void> {
  const drafts = diffMeta(before, after);
  if (!drafts.length) return;
  await safely(ex, "the model change", (sp) => writeEvents(sp, graphId, drafts, stamp));
}

/** Used by tests and the self-check: is the log reachable? */
export async function historyReachable(): Promise<boolean> {
  try { await db.execute(sql`select 1 from graph_events limit 1`); return true; } catch { return false; }
}
