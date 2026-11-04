/**
 * GBrain reads for versioning (server-only): the rows a change set's verdicts and the history's rewind need, always
 * filtered for the viewer and their current graph. Kept apart from index.ts so the contract file stays the contract.
 */
import { and, eq, inArray, isNull, notInArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/db";
import { edges, nodes, shares } from "@/db/schema";
import type { Viewer } from "@/lib/auth";
import { canReadItem, edgeSelfReadSql, nodeReadSql, type AccessCtx } from "./access";
import { accessContext, isUuid } from "./index";
import { edgeSnap, nodeSnap, type EdgeSnap, type GraphState, type NodeSnap } from "@/lib/history/pure";

/** Readable nodes (merged ones too) and facts (inactive too) by id, as snapshots. */
export async function readableSnapshots(v: Viewer, ids: { nodeIds?: string[]; edgeIds?: string[] }): Promise<{ nodes: Map<string, NodeSnap>; edges: Map<string, EdgeSnap> }> {
  const ctx = await accessContext(v);
  const nodeIds = [...new Set(ids.nodeIds ?? [])].filter(isUuid), edgeIds = [...new Set(ids.edgeIds ?? [])].filter(isUuid);
  const f = alias(nodes, "gf"), t = alias(nodes, "gt");
  const [n, e] = await Promise.all([
    nodeIds.length ? db.select().from(nodes).where(and(inArray(nodes.id, nodeIds), nodeReadSql(ctx, "nodes"))) : Promise.resolve([]),
    edgeIds.length
      ? db.select({ e: edges }).from(edges).innerJoin(f, eq(f.id, edges.fromId)).innerJoin(t, eq(t.id, edges.toId))
        .where(and(inArray(edges.id, edgeIds), edgeSelfReadSql(ctx, "edges"), nodeReadSql(ctx, "gf"), nodeReadSql(ctx, "gt")))
      : Promise.resolve([]),
  ]);
  return { nodes: new Map(n.map((r) => [r.id, nodeSnap(r)])), edges: new Map(e.map(({ e: r }) => [r.id, edgeSnap(r)])) };
}

/** Active facts among these nodes the viewer can see, as `from|relation|to`. */
export async function activeTriples(v: Viewer, nodeIds: string[]): Promise<Set<string>> {
  const ids = [...new Set(nodeIds)].filter(isUuid);
  if (!ids.length) return new Set();
  const ctx = await accessContext(v);
  const rows = await db.select({ fromId: edges.fromId, relation: edges.relation, toId: edges.toId }).from(edges)
    .where(and(inArray(edges.fromId, ids), inArray(edges.toId, ids), notInArray(edges.status, ["rejected", "superseded"]), edgeSelfReadSql(ctx, "edges")));
  return new Set(rows.map((r) => `${r.fromId}|${r.relation}|${r.toId}`));
}

/** Live readable nodes of these types, names only (for "something with that name was added since"). */
export async function namesOfType(v: Viewer, types: string[]): Promise<{ id: string; type: string; label: string; aliases: string[] }[]> {
  const want = [...new Set(types)];
  if (!want.length) return [];
  const ctx = await accessContext(v);
  return db.select({ id: nodes.id, type: nodes.type, label: nodes.label, aliases: nodes.aliases }).from(nodes)
    .where(and(isNull(nodes.mergedInto), inArray(nodes.type, want as never[]), nodeReadSql(ctx, "nodes"))).limit(20_000);
}

/** Every node and fact in the viewer's current graph, unfiltered — only for rewinding; filter with `readableState`. */
export async function wholeGraph(v: Viewer): Promise<GraphState> {
  if (!v.graphId) return { nodes: new Map(), edges: new Map() };
  const [n, e] = await Promise.all([
    db.select().from(nodes).where(eq(nodes.graphId, v.graphId)).limit(50_000),
    db.select().from(edges).where(eq(edges.graphId, v.graphId)).limit(100_000),
  ]);
  return { nodes: new Map(n.map((r) => [r.id, nodeSnap(r)])), edges: new Map(e.map((r) => [r.id, edgeSnap(r)])) };
}

/**
 * A (rewound) state cut down to what the viewer may see, judged on the state's own visibility at that moment and the
 * viewer's shares now. A fact needs itself and both ends readable.
 */
export async function readableState(v: Viewer, state: GraphState): Promise<GraphState> {
  const ctx: AccessCtx = await accessContext(v);
  const grants = await db.select({ nodeId: shares.nodeId, canEdit: shares.canEdit, expiresAt: shares.expiresAt }).from(shares).where(eq(shares.userId, v.id));
  const byNode = new Map<string, { canEdit: boolean; expiresAt: Date | null }[]>();
  for (const g of grants) byNode.set(g.nodeId, [...(byNode.get(g.nodeId) ?? []), { canEdit: g.canEdit, expiresAt: g.expiresAt }]);
  const readable = (n: NodeSnap) => canReadItem(ctx, { ownerId: n.ownerId, householdId: n.householdId, visibility: n.visibility, sensitive: n.sensitive, graphId: n.graphId }, byNode.get(n.id) ?? []);
  const outNodes = new Map([...state.nodes].filter(([, n]) => n.graphId === v.graphId && readable(n)));
  const outEdges = new Map([...state.edges].filter(([, e]) => {
    if (e.graphId !== v.graphId || !outNodes.has(e.fromId) || !outNodes.has(e.toId)) return false;
    if (e.ownerId === v.id) return true;
    const endShared = (byNode.get(e.fromId) ?? []).length > 0 || (byNode.get(e.toId) ?? []).length > 0;
    return endShared || canReadItem(ctx, { ownerId: e.ownerId, householdId: e.householdId, visibility: e.visibility, sensitive: false, graphId: e.graphId }, []);
  }));
  return { nodes: outNodes, edges: outEdges };
}
