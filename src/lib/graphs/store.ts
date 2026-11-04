/**
 * Graph storage primitives with no Next imports (scripts, auth and tests use them). Server-only.
 */
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { graphMembers, graphs, users } from "@/db/schema";
import {
  DEFAULT_HUES, familyGraphRole, pickGraph, type GraphContext, type GraphKind, type GraphRole, type Role,
} from "./pure";
import { ensureSelfNode } from "./self";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type Exec = typeof db | Tx;

export type GraphRecord = typeof graphs.$inferSelect;

/** The household's family graph, created (with every household member in it) when it doesn't exist yet. */
export async function ensureFamilyGraph(tx: Exec, householdId: string, ownerId: string | null): Promise<string> {
  const [g] = await tx.select({ id: graphs.id }).from(graphs)
    .where(and(eq(graphs.householdId, householdId), eq(graphs.kind, "family"))).orderBy(asc(graphs.createdAt)).limit(1);
  if (g) return g.id;
  const [row] = await tx.insert(graphs).values({ householdId, ownerId, name: "Family", kind: "family", color: DEFAULT_HUES.family })
    .returning({ id: graphs.id });
  const members = await tx.select({ id: users.id, role: users.role }).from(users).where(eq(users.householdId, householdId));
  if (members.length) {
    await tx.insert(graphMembers).values(members.map((m) => ({ graphId: row.id, userId: m.id, role: familyGraphRole(m.role), addedBy: ownerId })))
      .onConflictDoNothing();
  }
  return row.id;
}

/** The family graph of a household, if it has one. */
export async function familyGraphId(householdId: string, ex: Exec = db): Promise<string | null> {
  const [g] = await ex.select({ id: graphs.id }).from(graphs)
    .where(and(eq(graphs.householdId, householdId), eq(graphs.kind, "family"))).orderBy(asc(graphs.createdAt)).limit(1);
  return g?.id ?? null;
}

/** Add (or re-role) a member. */
export async function upsertMember(tx: Exec, graphId: string, userId: string, role: GraphRole, addedBy: string | null): Promise<void> {
  await tx.insert(graphMembers).values({ graphId, userId, role, addedBy })
    .onConflictDoUpdate({ target: [graphMembers.graphId, graphMembers.userId], set: { role } });
}

/** A new graph owned by `ownerId` (its household's meta model applies). */
export async function insertGraph(tx: Exec, g: { householdId: string; ownerId: string; name: string; kind: GraphKind; description?: string | null; color?: number }): Promise<GraphRecord> {
  const [row] = await tx.insert(graphs).values({
    householdId: g.householdId, ownerId: g.ownerId, name: g.name, kind: g.kind, description: g.description ?? null,
    color: g.color ?? DEFAULT_HUES[g.kind],
  }).returning();
  await upsertMember(tx, row.id, g.ownerId, "owner", g.ownerId);
  return row;
}

export type MyGraph = GraphRecord & { myRole: GraphRole; memberCount: number };

/**
 * Every live graph the user belongs to, with their role. In their own household's family graph the role follows
 * the household role (owner → owner, parent → editor, child/guest → viewer).
 */
export async function graphsOfUser(user: { id: string; householdId: string; role: Role }, opts: { includeArchived?: boolean } = {}, ex: Exec = db): Promise<MyGraph[]> {
  const rows = await ex.select({ g: graphs, role: graphMembers.role }).from(graphMembers)
    .innerJoin(graphs, eq(graphs.id, graphMembers.graphId))
    .where(and(eq(graphMembers.userId, user.id), opts.includeArchived ? undefined : isNull(graphs.archivedAt)))
    .orderBy(sql`(${graphs.kind} = 'family') desc`, asc(graphs.createdAt));
  const ids = rows.map((r) => r.g.id);
  const counts = ids.length
    ? await ex.select({ graphId: graphMembers.graphId, n: sql<number>`count(*)::int` }).from(graphMembers)
      .where(inArray(graphMembers.graphId, ids)).groupBy(graphMembers.graphId)
    : [];
  const countOf = new Map(counts.map((c) => [c.graphId, c.n]));
  return rows.map((r) => ({
    ...r.g,
    myRole: r.g.kind === "family" && r.g.householdId === user.householdId ? familyGraphRole(user.role) : r.role,
    memberCount: countOf.get(r.g.id) ?? 1,
  }));
}

export function toContext(g: Pick<GraphRecord, "id" | "name" | "kind" | "householdId" | "ownerId">, role: GraphRole): GraphContext {
  return { graphId: g.id, graphName: g.name, graphKind: g.kind, graphRole: role, graphHouseholdId: g.householdId, graphOwnerId: g.ownerId };
}

/**
 * The graph a signed-in user works in: `requested` (the mg_graph cookie) when they are a member of it, else their
 * family graph, else their first graph. A household member missing from their family graph is added (self-heal);
 * a user with no graph at all gets their household's family graph.
 */
export async function resolveGraph(user: { id: string; householdId: string; role: Role }, requested: string | null | undefined): Promise<GraphContext | null> {
  let mine = await graphsOfUser(user);
  if (!mine.some((g) => g.kind === "family" && g.householdId === user.householdId)) {
    const fam = await familyGraphId(user.householdId);
    if (fam || !mine.length) {
      await db.transaction(async (tx) => {
        const id = fam ?? (await ensureFamilyGraph(tx, user.householdId, user.role === "owner" ? user.id : null));
        await tx.insert(graphMembers).values({ graphId: id, userId: user.id, role: familyGraphRole(user.role) }).onConflictDoNothing();
      });
      mine = await graphsOfUser(user);
    }
  }
  const g = pickGraph(mine, user.householdId, requested);
  return g ? toContext(g, g.myRole) : null;
}

/** A user's context in one specific graph (background jobs, scripts, tests). Null when they are not a member. */
export async function contextIn(user: { id: string; householdId: string; role: Role }, graphId: string): Promise<GraphContext | null> {
  const mine = await graphsOfUser(user);
  const g = mine.find((x) => x.id === graphId);
  return g ? toContext(g, g.myRole) : null;
}

/**
 * The member's own person node in graph `g` (their "self" node), created on first use. In their own family graph it
 * is `users.personNodeId`. Null only if it can't be made right now (the database refused); never from another graph.
 */
export async function selfNodeIn(
  user: { id: string; householdId: string; role: Role; personNodeId: string | null; name?: string }, g: GraphContext,
  opts: { personNodeIdIsHome?: boolean } = {},
): Promise<string | null> {
  try {
    let name = user.name;
    if (!name) {
      const [u] = await db.select({ name: users.name }).from(users).where(eq(users.id, user.id));
      name = u?.name ?? "Me";
    }
    // `personNodeId` on a Viewer is the self node of the graph it was working in, so unless the caller says it is
    // straight from the users row, the home node is read from the users row inside.
    const home = opts.personNodeIdIsHome ? { personNodeId: user.personNodeId } : {};
    return await ensureSelfNode(db, { id: user.id, name, householdId: user.householdId, role: user.role, ...home }, { id: g.graphId, kind: g.graphKind, householdId: g.graphHouseholdId });
  } catch (e) {
    console.error("[graphs] could not resolve the member's own person node", e);
    return null;
  }
}

/**
 * The same person working in another graph (background jobs that must write where their source lives). Null when
 * they are not a member of it. `personNodeId` is their self node in that graph.
 */
export async function viewerInGraph<T extends { id: string; householdId: string; role: Role; personNodeId: string | null; name?: string }>(
  v: T, graphId: string,
): Promise<(T & GraphContext) | null> {
  if ((v as Partial<GraphContext>).graphId === graphId) return v as T & GraphContext;
  const g = await contextIn(v, graphId);
  if (!g) return null;
  return { ...v, personNodeId: await selfNodeIn(v, g), ...g };
}

/** A user row as a Viewer in their default graph, or in `graphId` (scripts, self-checks and DB tests). */
export async function viewerFor<T extends { id: string; householdId: string; role: Role; personNodeId: string | null; name?: string }>(
  row: T, graphId?: string,
): Promise<T & GraphContext> {
  const g = await resolveGraph(row, graphId ?? null);
  if (!g) throw new Error(`user ${row.id} has no graph`);
  if (graphId && g.graphId !== graphId) throw new Error(`user ${row.id} is not a member of graph ${graphId}`);
  return { ...row, personNodeId: await selfNodeIn(row, g), ...g };
}

/** User ids of every member of a graph. */
export async function memberIds(graphId: string, ex: Exec = db): Promise<string[]> {
  return (await ex.select({ id: graphMembers.userId }).from(graphMembers).where(eq(graphMembers.graphId, graphId))).map((r) => r.id);
}
