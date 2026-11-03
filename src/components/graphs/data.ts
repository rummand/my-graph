/** Server-only loaders for the graph switcher, the Graphs page and the new-graph welcome. */
import { cache } from "react";
import { asc, count, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { graphMembers, nodes, sources, users } from "@/db/schema";
import type { Viewer } from "@/lib/auth";
import { listGraphs } from "@/lib/graphs";
import type { GraphPerson, GraphView } from "./describe";

/** The viewer's graphs with the people in each (names and colours only; emails stay with the owner's view). */
export const loadGraphViews = cache(async (v: Viewer): Promise<GraphView[]> => {
  const list = await listGraphs(v);
  if (!list.length) return [];
  const rows = await db.select({
    graphId: graphMembers.graphId, userId: users.id, name: users.name, personNodeId: users.personNodeId, role: graphMembers.role,
  }).from(graphMembers).innerJoin(users, eq(users.id, graphMembers.userId))
    .where(inArray(graphMembers.graphId, list.map((g) => g.id)))
    .orderBy(asc(graphMembers.createdAt));
  const byGraph = new Map<string, GraphPerson[]>();
  for (const r of rows) {
    const arr = byGraph.get(r.graphId) ?? [];
    arr.push({ userId: r.userId, name: r.name, colorId: r.personNodeId ?? r.userId, role: r.role });
    byGraph.set(r.graphId, arr);
  }
  return list.map((g) => {
    const members = byGraph.get(g.id) ?? [];
    // Owner first, then the order people joined.
    members.sort((a, b) => Number(b.userId === g.ownerId) - Number(a.userId === g.ownerId));
    return {
      id: g.id, name: g.name, description: g.description, kind: g.kind, color: g.color, myRole: g.myRole,
      memberCount: g.memberCount, isFamily: g.isFamily, isCurrent: g.id === v.graphId, ownerId: g.ownerId,
      createdAt: g.createdAt, members,
    };
  });
});

/**
 * Whether the current graph is brand new: not the family graph, with nothing added yet apart from (at most) the
 * person's own node.
 */
export const isNewGraph = cache(async (v: Viewer): Promise<boolean> => {
  if (v.graphKind === "family") return false;
  const [[n], [s]] = await Promise.all([
    db.select({ n: count() }).from(nodes).where(eq(nodes.graphId, v.graphId)),
    db.select({ n: count() }).from(sources).where(eq(sources.graphId, v.graphId)),
  ]);
  return (n?.n ?? 0) <= 1 && (s?.n ?? 0) === 0;
});
