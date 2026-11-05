/**
 * Closeness for the viewer (server). Only interactions whose carrier the viewer may read count: a row from a source
 * counts when they may read that source, one from an event when they may read the event, a member's edit row by its
 * own visibility. So one member's private messages never move another member's picture of anyone.
 */
import { and, desc, eq, inArray, isNotNull, isNull, ne, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/db";
import { nodes, personInteractions, personPins, sources } from "@/db/schema";
import type { Viewer } from "@/lib/auth";
import { visibleWhere } from "@/lib/people/access";
import { closenessOf, type ClosenessView, type InteractionKind, type InteractionView } from "./pure";

const carrier = alias(nodes, "carrier");

export type { ClosenessView, InteractionView } from "./pure";
export type PersonCloseness = ClosenessView;

const hrefOf = (r: { sourceId: string | null; subjectId: string | null; kind: string }) =>
  r.sourceId ? `/library/${r.sourceId}` : r.subjectId && r.kind !== "edit" ? `/node/${r.subjectId}` : null;

/** Interactions with these people the viewer may read, newest first. */
async function readableInteractions(v: Viewer, personIds: string[], limit?: number) {
  if (!personIds.length || !v.graphId) return [];
  const q = db.select({
    id: personInteractions.id, nodeId: personInteractions.nodeId, kind: personInteractions.kind, at: personInteractions.at, weight: personInteractions.weight,
    sourceId: personInteractions.sourceId, subjectId: personInteractions.subjectId, detail: personInteractions.detail,
  }).from(personInteractions)
    .leftJoin(sources, eq(sources.id, personInteractions.sourceId))
    .leftJoin(carrier, eq(carrier.id, personInteractions.subjectId))
    .where(and(
      eq(personInteractions.graphId, v.graphId), inArray(personInteractions.nodeId, personIds),
      or(
        and(isNotNull(personInteractions.sourceId), isNotNull(sources.id), visibleWhere(v, { ownerId: sources.ownerId, householdId: sources.householdId, graphId: sources.graphId, visibility: sources.visibility, sensitive: sources.sensitive })),
        and(isNull(personInteractions.sourceId), ne(personInteractions.kind, "edit"), isNotNull(carrier.id), isNull(carrier.mergedInto),
          visibleWhere(v, { ownerId: carrier.ownerId, householdId: carrier.householdId, graphId: carrier.graphId, visibility: carrier.visibility, sensitive: carrier.sensitive, id: carrier.id })),
        and(eq(personInteractions.kind, "edit"), visibleWhere(v, personInteractions)),
      ),
    )).orderBy(desc(personInteractions.at));
  return limit ? q.limit(limit) : q;
}

/** The viewer's pinned people in this graph. */
export async function pinnedIds(v: Viewer): Promise<Set<string>> {
  if (!v.graphId) return new Set();
  const rows = await db.select({ nodeId: personPins.nodeId }).from(personPins).where(and(eq(personPins.graphId, v.graphId), eq(personPins.userId, v.id)));
  return new Set(rows.map((r) => r.nodeId));
}

const FAMILY_RELATIONS = new Set(["parent_of", "partner_of", "sibling_of", "grandparent_of", "role:parent", "role:child", "role:partner", "role:sibling", "role:grandparent"]);

/** People in close family with the viewer: a family relation (or family role) between them and the viewer's own node. */
export function closeFamilyOf(viewerNodeId: string | null, edges: readonly { fromId: string; toId: string; relation: string; status?: string }[]): Set<string> {
  const out = new Set<string>();
  if (!viewerNodeId) return out;
  for (const e of edges) {
    if (e.status === "rejected" || e.status === "superseded" || !FAMILY_RELATIONS.has(e.relation)) continue;
    if (e.fromId === viewerNodeId && e.toId !== viewerNodeId) out.add(e.toId);
    else if (e.toId === viewerNodeId && e.fromId !== viewerNodeId) out.add(e.fromId);
  }
  return out;
}

/** Closeness of each person for the viewer. */
export async function closenessFor(v: Viewer, people: { id: string; createdAt: Date | string }[], ctx: {
  viewerNodeId: string | null; members: ReadonlySet<string>; family: ReadonlySet<string>; now?: Date;
}): Promise<Map<string, PersonCloseness>> {
  const now = ctx.now ?? new Date();
  const ids = people.map((p) => p.id);
  const [rows, pins] = await Promise.all([readableInteractions(v, ids).catch((e) => { console.error("[closeness] read failed", e); return []; }), pinnedIds(v)]);
  const byPerson = new Map<string, typeof rows>();
  for (const r of rows) (byPerson.get(r.nodeId) ?? byPerson.set(r.nodeId, []).get(r.nodeId)!).push(r);
  const out = new Map<string, PersonCloseness>();
  for (const p of people) {
    const mine = byPerson.get(p.id) ?? [];
    const c = closenessOf({
      rows: mine, createdAt: p.createdAt, pinned: pins.has(p.id), member: ctx.members.has(p.id), family: ctx.family.has(p.id), isViewer: p.id === ctx.viewerNodeId,
    }, now);
    const last = c.lastInTouch;
    const lastRow = last ? mine.find((r) => r.at.toISOString() === last.at) : undefined;
    out.set(p.id, {
      ...c, pinned: pins.has(p.id),
      lastInTouch: last && lastRow ? { id: lastRow.id, kind: last.kind, at: last.at, detail: last.detail, href: hrefOf(lastRow) } : null,
    });
  }
  return out;
}

/** The person page's small timeline: the latest interactions the viewer may read. */
export async function interactionsFor(v: Viewer, personId: string, limit = 12): Promise<InteractionView[]> {
  const rows = await readableInteractions(v, [personId], limit).catch(() => []);
  return rows.map((r) => ({ id: r.id, kind: r.kind as InteractionKind, at: r.at.toISOString(), detail: r.detail, href: hrefOf(r) }));
}

/** Pin or unpin someone for the viewer (the person must be a person they can see in this graph). */
export async function setPinned(v: Viewer, nodeId: string, pinned: boolean): Promise<boolean> {
  if (!v.graphId) return false;
  const [n] = await db.select({ id: nodes.id }).from(nodes).where(and(eq(nodes.id, nodeId), eq(nodes.type, "person"), isNull(nodes.mergedInto), visibleWhere(v, nodes)));
  if (!n) return false;
  if (pinned) await db.insert(personPins).values({ graphId: v.graphId, userId: v.id, nodeId }).onConflictDoNothing();
  else await db.delete(personPins).where(and(eq(personPins.graphId, v.graphId), eq(personPins.userId, v.id), eq(personPins.nodeId, nodeId)));
  return true;
}
