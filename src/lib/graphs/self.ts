/**
 * Members as people: every member of a graph has a "self" person node in that graph (server-only, no Next imports so
 * scripts and auth can use it).
 *
 * Found by graph + owner + `props->>'userId'` + `props->>'self'` (no schema column). In the member's own household's
 * family graph it is the existing `users.personNodeId` node, stamped with the same marker, never a duplicate.
 * Created idempotently (advisory lock per graph and user) when a graph is made, when someone joins, at setup, and
 * lazily the first time a viewer is resolved in a graph. Never linked across graphs; leaving a graph keeps the node.
 */
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { graphMembers, graphs, nodes, provenance, users } from "@/db/schema";
import {
  isSelfOf, pickSelfNode, selfKind, selfProps, selfVisibility, usesFamilyRules, type GraphKind, type Role, type SelfCandidate,
} from "./pure";
import type { Exec } from "./store";

export type SelfUser = { id: string; name: string; householdId: string; role: Role; personNodeId?: string | null };
export type SelfGraph = { id: string; kind: GraphKind; householdId: string };

async function candidates(ex: Exec, userId: string, graphId: string, homeNodeId: string | null | undefined, adoptName?: string): Promise<SelfCandidate[]> {
  const mine = eq(nodes.ownerId, userId);
  const marked = and(mine, sql`${nodes.props}->>'self' = 'true'`, sql`${nodes.props}->>'userId' = ${userId}`);
  const named = adoptName ? and(mine, sql`${nodes.props}->>'self' is null`, sql`lower(${nodes.label}) = lower(${adoptName.trim()})`) : undefined;
  return ex.select({ id: nodes.id, label: nodes.label, props: nodes.props, mergedInto: nodes.mergedInto, ownerId: nodes.ownerId, createdAt: nodes.createdAt })
    .from(nodes)
    .where(and(eq(nodes.graphId, graphId), eq(nodes.type, "person"), or(homeNodeId ? eq(nodes.id, homeNodeId) : undefined, marked, named)))
    .orderBy(asc(nodes.createdAt)).limit(10);
}

async function homeNodeOf(ex: Exec, u: SelfUser): Promise<string | null> {
  if (u.personNodeId !== undefined) return u.personNodeId;
  const [row] = await ex.select({ p: users.personNodeId }).from(users).where(eq(users.id, u.id));
  return row?.p ?? null;
}

/** Stamp the marker on a node that is the member's self node but doesn't carry it yet (their family node). */
async function stamp(ex: Exec, c: SelfCandidate, userId: string): Promise<void> {
  if (isSelfOf(c.props, userId)) return;
  await ex.update(nodes).set({ props: sql`${nodes.props} || ${JSON.stringify(selfProps(userId))}::jsonb` }).where(eq(nodes.id, c.id));
}

/** The member's self node in this graph, or null (read only; no creation). */
export async function findSelfNodeId(ex: Exec, userId: string, graphId: string, homeNodeId?: string | null): Promise<string | null> {
  return pickSelfNode(await candidates(ex, userId, graphId, homeNodeId), userId, homeNodeId)?.id ?? null;
}

/**
 * The member's self node in `graph`, created when missing. `actorId` is who caused it (the graph owner adding
 * someone, or the member themselves). Callers must have checked membership; this never touches another graph.
 */
export async function ensureSelfNode(ex: Exec, user: SelfUser, graph: SelfGraph, opts: { actorId?: string | null; note?: string } = {}): Promise<string> {
  const home = await homeNodeOf(ex, user);
  const rows = await candidates(ex, user.id, graph.id, home, user.name);
  const hit = pickSelfNode(rows, user.id, home, user.name);
  if (hit) { await stamp(ex, hit, user.id); return hit.id; }
  // Their self node was merged into another person (entity resolution): that one is them now.
  const merged = rows.find((r) => r.mergedInto && r.ownerId === user.id && isSelfOf(r.props, user.id));
  if (merged?.mergedInto) {
    const [target] = await ex.select({ id: nodes.id, label: nodes.label, props: nodes.props, mergedInto: nodes.mergedInto, ownerId: nodes.ownerId, createdAt: nodes.createdAt })
      .from(nodes).where(and(eq(nodes.id, merged.mergedInto), eq(nodes.graphId, graph.id), eq(nodes.type, "person"), isNull(nodes.mergedInto)));
    if (target && (target.props.self === undefined || isSelfOf(target.props, user.id))) { await stamp(ex, target, user.id); return target.id; }
  }

  return ex.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`mygraph:self:${graph.id}:${user.id}`}))`);
    const again = pickSelfNode(await candidates(tx, user.id, graph.id, home, user.name), user.id, home, user.name);
    if (again) { await stamp(tx, again, user.id); return again.id; }
    const family = usesFamilyRules(user.householdId, { graphKind: graph.kind, graphHouseholdId: graph.householdId });
    const props: Record<string, unknown> = { ...selfProps(user.id), ...(family ? { householdMember: true } : {}) };
    const [row] = await tx.insert(nodes).values({
      householdId: graph.householdId, graphId: graph.id, ownerId: user.id, type: "person", kind: selfKind(user.role, family),
      label: user.name, props, visibility: selfVisibility(user.role, family),
    }).returning({ id: nodes.id });
    await tx.insert(provenance).values({
      householdId: graph.householdId, graphId: graph.id, subjectType: "node", subjectId: row.id, activity: "manual_edit",
      agentType: "user", agentId: opts.actorId ?? user.id, confidence: 1, note: opts.note ?? "A member of this graph",
    });
    // Their own family graph had no person node for them: this one becomes it.
    if (family && !home) await tx.update(users).set({ personNodeId: row.id }).where(eq(users.id, user.id));
    return row.id;
  });
}

/** Self nodes for every current member of a graph (seed script, backfills). Returns userId → node id. */
export async function ensureSelfNodesForGraph(ex: Exec, graphId: string, actorId?: string | null): Promise<Map<string, string>> {
  const [g] = await ex.select({ id: graphs.id, kind: graphs.kind, householdId: graphs.householdId }).from(graphs).where(eq(graphs.id, graphId));
  const out = new Map<string, string>();
  if (!g) return out;
  const members = await ex.select({ id: users.id, name: users.name, householdId: users.householdId, role: users.role, personNodeId: users.personNodeId })
    .from(graphMembers).innerJoin(users, eq(users.id, graphMembers.userId)).where(eq(graphMembers.graphId, graphId));
  for (const m of members) out.set(m.id, await ensureSelfNode(ex, m, g, { actorId: actorId ?? m.id }));
  return out;
}

/**
 * Self nodes of the current members of a graph: userId → node id. Members who have none yet are left out.
 * Leaving a graph keeps the node; it just stops being listed here.
 */
export async function memberSelfNodes(graphId: string, ex: Exec = db): Promise<Map<string, string>> {
  const members = await ex.select({ id: users.id, home: users.personNodeId }).from(graphMembers)
    .innerJoin(users, eq(users.id, graphMembers.userId)).where(eq(graphMembers.graphId, graphId));
  if (!members.length) return new Map();
  const ids = members.map((m) => m.id);
  const homes = members.map((m) => m.home).filter((h): h is string => !!h);
  const rows = await ex.select({ id: nodes.id, label: nodes.label, props: nodes.props, mergedInto: nodes.mergedInto, ownerId: nodes.ownerId, createdAt: nodes.createdAt })
    .from(nodes)
    .where(and(eq(nodes.graphId, graphId), eq(nodes.type, "person"), or(
      homes.length ? inArray(nodes.id, homes) : undefined,
      and(inArray(nodes.ownerId, ids), sql`${nodes.props}->>'self' = 'true'`),
    )))
    .orderBy(asc(nodes.createdAt));
  const out = new Map<string, string>();
  for (const m of members) {
    const pick = pickSelfNode(rows.filter((r) => r.id === m.home || r.ownerId === m.id), m.id, m.home);
    if (pick) out.set(m.id, pick.id);
  }
  return out;
}
