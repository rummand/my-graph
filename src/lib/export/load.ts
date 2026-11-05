/**
 * Loading what goes into an export (server-only). Every graph is read as the person would read it when signed in:
 * the Viewer for that graph (membership re-checked), the GBrain access rules (nodeReadSql, edgeSelfReadSql,
 * sourceReadSql, canReadItem), and `graph_id = <that graph>` on every query. In "mine" mode only rows they added.
 */
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { db } from "@/db";
import {
  artifacts, conversations, edges, graphEvents, graphs, households, memories, messages, nodes, provenance, reminders, sources, users,
  wikiPages, wikiRevisions,
} from "@/db/schema";
import { viewerFor } from "@/lib/auth/viewer-for";
import { accessContext } from "@/lib/gbrain";
import { canReadItem, edgeSelfReadSql, nodeReadSql, sourceReadSql } from "@/lib/gbrain/access";
import { graphsOfUser } from "@/lib/graphs/store";
import type { GraphDataset, Row } from "./format";

const CHUNK = 1000;

async function inChunks<T>(ids: string[], fn: (part: string[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) out.push(...(await fn(ids.slice(i, i + CHUNK))));
  return out;
}

const asRows = <T extends { id: string }>(rows: T[]) => rows as unknown as Row[];

/** Load one graph for `userId`. Null when they aren't a member (any more). */
export async function loadGraph(userId: string, graphId: string, mode: "full" | "mine"): Promise<GraphDataset | null> {
  const v = await viewerFor(userId, graphId);
  if (!v || v.graphId !== graphId) return null;
  const ctx = await accessContext(v);
  const mine = (col: SQL | AnyPgColumn) => (mode === "mine" ? sql`${col} = ${userId}` : sql`true`);

  const [g] = await db.select({ id: graphs.id, name: graphs.name, kind: graphs.kind, createdAt: graphs.createdAt }).from(graphs).where(eq(graphs.id, graphId));
  if (!g) return null;

  // Nodes: every readable node's id/label (for edges' ends), and the full rows that are exported.
  const visible = await db.select({ id: nodes.id, type: nodes.type, kind: nodes.kind, label: nodes.label, graphId: nodes.graphId, ownerId: nodes.ownerId })
    .from(nodes).where(and(eq(nodes.graphId, graphId), nodeReadSql(ctx, "nodes")));
  const nodeRows = await db.select().from(nodes).where(and(eq(nodes.graphId, graphId), nodeReadSql(ctx, "nodes"), mine(nodes.ownerId)));
  const visibleIds = new Set(visible.map((n) => n.id));

  const edgeRows = (await db.select().from(edges).where(and(eq(edges.graphId, graphId), edgeSelfReadSql(ctx, "edges"), mine(edges.ownerId))))
    .filter((e) => visibleIds.has(e.fromId) && visibleIds.has(e.toId));
  const exportedNodeIds = new Set(nodeRows.map((n) => n.id));
  const referencedNodes = mode === "mine"
    ? visible.filter((n) => !exportedNodeIds.has(n.id) && edgeRows.some((e) => e.fromId === n.id || e.toId === n.id))
    : [];

  const sourceRows = await db.select().from(sources).where(and(eq(sources.graphId, graphId), sourceReadSql(ctx, "sources"), mine(sources.ownerId)));

  const subjectIds = [...nodeRows.map((n) => n.id), ...edgeRows.map((e) => e.id)];
  const provRows = await inChunks(subjectIds, (part) => db.select().from(provenance)
    .where(and(eq(provenance.graphId, graphId), inArray(provenance.subjectId, part))));

  const pageRows = (await db.select().from(wikiPages).where(and(eq(wikiPages.graphId, graphId), mine(wikiPages.ownerId))))
    .filter((p) => canReadItem(ctx, { ownerId: p.ownerId, householdId: p.householdId, visibility: p.visibility, sensitive: false, graphId: p.graphId }));
  const revRows = await inChunks(pageRows.map((p) => p.id), (part) => db.select().from(wikiRevisions).where(inArray(wikiRevisions.pageId, part)));

  const historyIds = [...subjectIds, ...pageRows.map((p) => p.id), ...sourceRows.map((s) => s.id)];
  const historyRows = await inChunks(historyIds, (part) => db.select().from(graphEvents)
    .where(and(eq(graphEvents.graphId, graphId), inArray(graphEvents.subjectId, part))));

  const reminderRows = await db.select().from(reminders).where(and(eq(reminders.graphId, graphId), eq(reminders.ownerId, userId)));
  const convRows = await db.select().from(conversations).where(and(eq(conversations.graphId, graphId), eq(conversations.userId, userId)));
  const msgRows = await inChunks(convRows.map((c) => c.id), (part) => db.select().from(messages).where(inArray(messages.conversationId, part)));
  const memoryRows = await db.select().from(memories).where(and(eq(memories.graphId, graphId), eq(memories.ownerId, userId)));
  const artifactRows = (await db.select().from(artifacts).where(and(eq(artifacts.graphId, graphId), mine(artifacts.ownerId))))
    .filter((a) => canReadItem(ctx, { ownerId: a.ownerId, householdId: ctx.householdId, visibility: a.visibility, sensitive: a.sensitive, graphId: a.graphId }));

  return {
    graph: { id: g.id, name: g.name, kind: g.kind, role: v.graphRole, createdAt: g.createdAt },
    mode,
    nodes: asRows(nodeRows), edges: asRows(edgeRows), provenance: asRows(provRows), sources: asRows(sourceRows),
    wikiPages: asRows(pageRows), wikiRevisions: asRows(revRows), history: asRows(historyRows), reminders: asRows(reminderRows),
    conversations: asRows(convRows), messages: asRows(msgRows), memories: asRows(memoryRows), artifacts: asRows(artifactRows),
    referencedNodes: asRows(referencedNodes),
  };
}

/** The graphs an export covers: one graph they own, or (account) every graph they belong to. */
export async function exportPlan(userId: string, scope: "graph" | "account", graphId: string | null): Promise<{ graphId: string; mode: "full" | "mine" }[]> {
  const [u] = await db.select({ id: users.id, householdId: users.householdId, role: users.role }).from(users).where(eq(users.id, userId));
  if (!u) return [];
  const mineGraphs = await graphsOfUser(u, { includeArchived: true });
  if (scope === "graph") {
    const g = mineGraphs.find((x) => x.id === graphId);
    return g && g.myRole === "owner" ? [{ graphId: g.id, mode: "full" }] : [];
  }
  return mineGraphs.map((g) => ({ graphId: g.id, mode: g.myRole === "owner" ? "full" as const : "mine" as const }));
}

/** account.json: who they are, their household's name and the graphs they belong to. */
export async function loadAccount(userId: string): Promise<{ person: { id: string; name: string; email: string }; account: Record<string, unknown> } | null> {
  const [u] = await db.select().from(users).where(eq(users.id, userId));
  if (!u) return null;
  const [h] = await db.select({ name: households.name }).from(households).where(eq(households.id, u.householdId));
  const gs = await graphsOfUser(u, { includeArchived: true });
  return {
    person: { id: u.id, name: u.name, email: u.email },
    account: {
      id: u.id, name: u.name, email: u.email, role: u.role, birthYear: u.birthYear, locale: u.locale, timeZone: u.timeZone,
      theme: u.theme, createdAt: u.createdAt.toISOString(), household: { id: u.householdId, name: h?.name ?? null },
      graphs: gs.map((g) => ({ id: g.id, name: g.name, kind: g.kind, role: g.myRole, archived: !!g.archivedAt })),
    },
  };
}
