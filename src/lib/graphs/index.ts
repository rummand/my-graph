/**
 * Graphs contract. Server-only. A person owns several graphs (Family, Personal, Work, one built for someone) and
 * shares a graph with specific people; they see that graph and nothing from the owner's other graphs.
 *
 * Every function takes the Viewer and checks membership itself. Errors are GraphError (status → HTTP status).
 * The pure rules live in ./pure (tested), storage primitives in ./store.
 */
import { createHash, randomBytes } from "node:crypto";
import { and, asc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { graphInvites, graphMembers, graphs, households, shares, nodes, users } from "@/db/schema";
import type { Viewer } from "@/lib/auth";
import { writeAudit } from "@/lib/auth/audit";
import { createAccount } from "@/lib/auth/members";
import {
  archiveProblem, DEFAULT_HUES, inviteState, memberChangeProblem, type GraphKind, type GraphRole, type Role,
} from "./pure";
import { ensureSelfNode } from "./self";
import { graphsOfUser, upsertMember, type GraphRecord } from "./store";

export * from "./pure";
export { graphsOfUser, resolveGraph, viewerFor, viewerInGraph, memberIds, familyGraphId, selfNodeIn } from "./store";
export { ensureSelfNode, ensureSelfNodesForGraph, findSelfNodeId, memberSelfNodes } from "./self";

/** A viewer as a member for self-node lookups (their Viewer.personNodeId belongs to the graph they were working in). */
const asMember = (v: Viewer) => ({ id: v.id, name: v.name, householdId: v.householdId, role: v.role });

export class GraphError extends Error {
  constructor(public status: 400 | 403 | 404 | 409 | 429, message: string, public extra?: Record<string, unknown>) {
    super(message);
    this.name = "GraphError";
  }
}

export const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export type GraphSummary = {
  id: string; name: string; description: string | null; color: number; kind: GraphKind;
  myRole: GraphRole; memberCount: number; ownerId: string | null; isFamily: boolean; isCurrent: boolean;
  archivedAt: string | null; createdAt: string;
};

export type GraphMember = { userId: string; name: string; email: string | null; role: GraphRole; isYou: boolean; addedAt: string };
export type GraphInviteView = { id: string; email: string; role: GraphRole; expiresAt: string; createdAt: string; state: ReturnType<typeof inviteState> };

function summary(v: Pick<Viewer, "householdId" | "graphId">, g: GraphRecord & { myRole: GraphRole; memberCount: number }): GraphSummary {
  return {
    id: g.id, name: g.name, description: g.description, color: g.color, kind: g.kind, myRole: g.myRole, memberCount: g.memberCount,
    ownerId: g.ownerId, isFamily: g.kind === "family" && g.householdId === v.householdId, isCurrent: g.id === v.graphId,
    archivedAt: g.archivedAt?.toISOString() ?? null, createdAt: g.createdAt.toISOString(),
  };
}

export const hashInviteToken = (token: string) => createHash("sha256").update(token).digest("hex");
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
export const isInviteToken = (t: unknown): t is string => typeof t === "string" && TOKEN_RE.test(t);

/* ── Reading ─────────────────────────────────────────────────────────────────────────────────────────── */

/** The viewer's graphs (live), with their role and member count. */
export async function listGraphs(v: Viewer): Promise<GraphSummary[]> {
  return (await graphsOfUser(v)).map((g) => summary(v, g));
}

/** One of the viewer's graphs, or 404 (never reveals graphs they are not in). */
export async function getGraph(v: Viewer, id: string): Promise<GraphSummary> {
  const g = (await graphsOfUser(v)).find((x) => x.id === id);
  if (!g) throw new GraphError(404, "That graph doesn't exist, or you're not in it.");
  return summary(v, g);
}

async function myGraph(v: Viewer, id: string) {
  const g = (await graphsOfUser(v)).find((x) => x.id === id);
  if (!g) throw new GraphError(404, "That graph doesn't exist, or you're not in it.");
  return g;
}

async function ownGraph(v: Viewer, id: string) {
  const g = await myGraph(v, id);
  if (g.myRole !== "owner") throw new GraphError(403, "Only the graph's owner can do this.");
  return g;
}

/* ── Creating and changing graphs ────────────────────────────────────────────────────────────────────── */

export async function createGraph(v: Viewer, input: { name: string; description?: string | null; kind: Exclude<GraphKind, "family">; color?: number }): Promise<GraphSummary> {
  if (v.role === "guest") throw new GraphError(403, "Guests can't make graphs.");
  const owned = (await graphsOfUser(v)).filter((g) => g.myRole === "owner" && g.ownerId === v.id).length;
  if (owned >= 50) throw new GraphError(400, "You already have 50 graphs. Archive one you no longer use first.");
  const row = await db.transaction(async (tx) => {
    const [g] = await tx.insert(graphs).values({
      householdId: v.householdId, ownerId: v.id, name: input.name, description: input.description ?? null, kind: input.kind,
      color: input.color ?? DEFAULT_HUES[input.kind],
    }).returning();
    await upsertMember(tx, g.id, v.id, "owner", v.id);
    // The owner is a person in their new graph from the start.
    await ensureSelfNode(tx, asMember(v), { id: g.id, kind: g.kind, householdId: g.householdId }, { actorId: v.id, note: "Made this graph" });
    return g;
  });
  await writeAudit(v, "graph.create", { type: "graph", id: row.id }, { name: row.name, kind: row.kind });
  return summary(v, { ...row, myRole: "owner", memberCount: 1 });
}

export async function updateGraph(v: Viewer, id: string, patch: { name?: string; description?: string | null; color?: number; kind?: Exclude<GraphKind, "family"> }): Promise<GraphSummary> {
  const g = await ownGraph(v, id);
  if (patch.kind && g.kind === "family") throw new GraphError(400, "The family graph stays the family graph.");
  const set: Partial<typeof graphs.$inferInsert> = {};
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.description !== undefined) set.description = patch.description;
  if (patch.color !== undefined) set.color = patch.color;
  if (patch.kind !== undefined) set.kind = patch.kind;
  if (Object.keys(set).length) {
    await db.update(graphs).set(set).where(eq(graphs.id, id));
    await writeAudit(v, "graph.update", { type: "graph", id }, { changed: Object.keys(set) });
  }
  return getGraph(v, id);
}

/** Archive (never delete): the graph disappears from everyone's list; its content stays in the database. */
export async function archiveGraph(v: Viewer, id: string): Promise<void> {
  const g = await ownGraph(v, id);
  const live = (await graphsOfUser(v)).length;
  const problem = archiveProblem(g, live);
  if (problem) throw new GraphError(409, problem);
  await db.update(graphs).set({ archivedAt: new Date() }).where(eq(graphs.id, id));
  await writeAudit(v, "graph.archive", { type: "graph", id }, { name: g.name });
}

/* ── Members ─────────────────────────────────────────────────────────────────────────────────────────── */

/** Members of a graph the viewer is in. Email addresses are shown to the owner only. */
export async function listMembers(v: Viewer, graphId: string): Promise<{ members: GraphMember[]; invites: GraphInviteView[] }> {
  const g = await myGraph(v, graphId);
  const rows = await db.select({ userId: users.id, name: users.name, email: users.email, householdRole: users.role, householdId: users.householdId, role: graphMembers.role, addedAt: graphMembers.createdAt })
    .from(graphMembers).innerJoin(users, eq(users.id, graphMembers.userId))
    .where(eq(graphMembers.graphId, g.id)).orderBy(asc(graphMembers.createdAt));
  const owner = g.myRole === "owner";
  const isFamily = g.kind === "family";
  const members = rows.map((r) => ({
    userId: r.userId, name: r.name, email: owner ? r.email : null,
    role: isFamily && r.householdId === g.householdId ? (r.householdRole === "owner" ? "owner" : r.householdRole === "parent" ? "editor" : "viewer") as GraphRole : r.role,
    isYou: r.userId === v.id, addedAt: r.addedAt.toISOString(),
  }));
  let invites: GraphInviteView[] = [];
  if (owner && !isFamily) {
    const inv = await db.select().from(graphInvites)
      .where(and(eq(graphInvites.graphId, g.id), isNull(graphInvites.acceptedAt), isNull(graphInvites.revokedAt), gt(graphInvites.expiresAt, new Date())))
      .orderBy(asc(graphInvites.createdAt));
    invites = inv.map((i) => ({ id: i.id, email: i.email, role: i.role, expiresAt: i.expiresAt.toISOString(), createdAt: i.createdAt.toISOString(), state: inviteState(i) }));
  }
  return { members, invites };
}

async function addMemberRow(v: Viewer, g: GraphRecord, user: { id: string; name: string; householdId: string; role: Role }, role: Exclude<GraphRole, "owner">, via: "direct" | "invite") {
  const [existing] = await db.select({ role: graphMembers.role }).from(graphMembers)
    .where(and(eq(graphMembers.graphId, g.id), eq(graphMembers.userId, user.id)));
  if (existing) throw new GraphError(409, `${user.name} is already in this graph.`);
  await db.transaction(async (tx) => {
    await upsertMember(tx, g.id, user.id, role, v.id);
    await ensureSelfNode(tx, user, { id: g.id, kind: g.kind, householdId: g.householdId }, { actorId: v.id, note: "Added to this graph" });
  });
  await writeAudit({ id: v.id, householdId: g.householdId }, "graph.member_add", { type: "graph", id: g.id }, { userId: user.id, name: user.name, role, via });
}

/** Add someone who already has an account (by email or username). Owner only, never into the family graph. */
export async function addMemberByEmail(v: Viewer, graphId: string, input: { email: string; role: Exclude<GraphRole, "owner"> }): Promise<GraphMember> {
  const g = await ownGraph(v, graphId);
  if (g.kind === "family") throw new GraphError(400, "People in the household are added in Family settings.");
  const [u] = await db.select({ id: users.id, name: users.name, email: users.email, householdId: users.householdId, role: users.role })
    .from(users).where(eq(users.email, input.email.toLowerCase())).limit(1);
  if (!u) throw new GraphError(404, "Nobody signs in with that email yet. Send them an invite link instead.", { canInvite: true });
  await addMemberRow(v, g, u, input.role, "direct");
  return { userId: u.id, name: u.name, email: u.email, role: input.role, isYou: u.id === v.id, addedAt: new Date().toISOString() };
}

/** Change a member's role (owner only), or remove someone (owner), or leave (yourself). */
export async function changeMember(v: Viewer, graphId: string, userId: string, change: { role: Exclude<GraphRole, "owner"> } | { remove: true }): Promise<void> {
  const g = await myGraph(v, graphId);
  const [target] = await db.select({ role: graphMembers.role, name: users.name }).from(graphMembers)
    .innerJoin(users, eq(users.id, graphMembers.userId))
    .where(and(eq(graphMembers.graphId, g.id), eq(graphMembers.userId, userId)));
  const action = "remove" in change ? "remove" : "role";
  const problem = memberChangeProblem({
    actorId: v.id, actorRole: g.myRole, targetId: userId, targetRole: target?.role ?? null, action,
    newRole: "role" in change ? change.role : undefined, graphKind: g.kind,
  });
  if (problem) throw new GraphError(target ? 403 : 404, problem);
  if ("role" in change) {
    await db.update(graphMembers).set({ role: change.role }).where(and(eq(graphMembers.graphId, g.id), eq(graphMembers.userId, userId)));
    await writeAudit({ id: v.id, householdId: g.householdId }, "graph.member_role", { type: "graph", id: g.id }, { userId, name: target!.name, role: change.role });
    return;
  }
  await db.transaction(async (tx) => {
    await tx.delete(graphMembers).where(and(eq(graphMembers.graphId, g.id), eq(graphMembers.userId, userId)));
    // Explicit shares of this graph's items to them go too (they could no longer reach them anyway).
    await tx.delete(shares).where(and(eq(shares.userId, userId),
      inArray(shares.nodeId, tx.select({ id: nodes.id }).from(nodes).where(eq(nodes.graphId, g.id)))));
  });
  await writeAudit({ id: v.id, householdId: g.householdId }, userId === v.id ? "graph.leave" : "graph.member_remove", { type: "graph", id: g.id }, { userId, name: target!.name });
}

/* ── Invites ─────────────────────────────────────────────────────────────────────────────────────────── */

export type InviteResult =
  | { added: true; member: GraphMember }
  | { added: false; invite: GraphInviteView; token: string };

/**
 * Invite someone by email (owner only, never into the family graph). Someone who already has an account is added
 * straight away; otherwise a link token is made (valid 14 days, stored only as its sha256).
 */
export async function createInvite(v: Viewer, graphId: string, input: { email: string; role: Exclude<GraphRole, "owner"> }): Promise<InviteResult> {
  const g = await ownGraph(v, graphId);
  if (g.kind === "family") throw new GraphError(400, "The family graph is for the household. Add people in Family settings, or make a new graph to share.");
  const email = input.email.toLowerCase();
  const [u] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (u) return { added: true, member: await addMemberByEmail(v, graphId, { email, role: input.role }) };
  // One open invite per email per graph: a new one replaces the old link.
  await db.update(graphInvites).set({ revokedAt: new Date() })
    .where(and(eq(graphInvites.graphId, g.id), eq(graphInvites.email, email), isNull(graphInvites.acceptedAt), isNull(graphInvites.revokedAt)));
  const token = randomBytes(32).toString("base64url");
  const [row] = await db.insert(graphInvites).values({
    graphId: g.id, email, role: input.role, tokenHash: hashInviteToken(token), createdBy: v.id, expiresAt: new Date(Date.now() + INVITE_TTL_MS),
  }).returning();
  await writeAudit({ id: v.id, householdId: g.householdId }, "graph.invite_create", { type: "graph", id: g.id }, { email, role: input.role, inviteId: row.id });
  return { added: false, token, invite: { id: row.id, email, role: row.role, expiresAt: row.expiresAt.toISOString(), createdAt: row.createdAt.toISOString(), state: "open" } };
}

export async function revokeInvite(v: Viewer, graphId: string, inviteId: string): Promise<void> {
  const g = await ownGraph(v, graphId);
  const [row] = await db.update(graphInvites).set({ revokedAt: new Date() })
    .where(and(eq(graphInvites.id, inviteId), eq(graphInvites.graphId, g.id), isNull(graphInvites.acceptedAt), isNull(graphInvites.revokedAt)))
    .returning({ id: graphInvites.id, email: graphInvites.email });
  if (!row) throw new GraphError(404, "That invite doesn't exist or was already used.");
  await writeAudit({ id: v.id, householdId: g.householdId }, "graph.invite_revoke", { type: "graph", id: g.id }, { email: row.email, inviteId });
}

async function loadInvite(token: string) {
  if (!isInviteToken(token)) return null;
  const [row] = await db.select({
    i: graphInvites, graphName: graphs.name, graphArchived: graphs.archivedAt, graphHousehold: graphs.householdId, graphKind: graphs.kind,
    inviterName: users.name,
  }).from(graphInvites).innerJoin(graphs, eq(graphs.id, graphInvites.graphId)).leftJoin(users, eq(users.id, graphInvites.createdBy))
    .where(eq(graphInvites.tokenHash, hashInviteToken(token))).limit(1);
  return row ?? null;
}

export type InvitePreview = {
  graphName: string; inviterName: string; email: string; role: GraphRole; hasAccount: boolean;
  state: "open" | "accepted" | "revoked" | "expired"; expiresAt: string;
};

/** What the invite page shows before anyone signs in. Only the token holder learns this. */
export async function previewInvite(token: string): Promise<InvitePreview> {
  const row = await loadInvite(token);
  if (!row || row.graphArchived) throw new GraphError(404, "This invite link doesn't work. Ask for a new one.");
  const [u] = await db.select({ id: users.id }).from(users).where(eq(users.email, row.i.email)).limit(1);
  return {
    graphName: row.graphName, inviterName: row.inviterName ?? "Someone", email: row.i.email, role: row.i.role,
    hasAccount: !!u, state: inviteState(row.i), expiresAt: row.i.expiresAt.toISOString(),
  };
}

function assertOpen(row: NonNullable<Awaited<ReturnType<typeof loadInvite>>>) {
  if (row.graphArchived) throw new GraphError(404, "This graph is no longer available.");
  const state = inviteState(row.i);
  if (state === "accepted") throw new GraphError(409, "This invite has already been used.");
  if (state === "revoked") throw new GraphError(404, "This invite was cancelled. Ask for a new one.");
  if (state === "expired") throw new GraphError(404, "This invite has expired. Ask for a new one.");
}

/** Signed in: join the graph the invite is for. The invite is for one email; you must be signed in as that person. */
export async function acceptInviteAsUser(v: Viewer, token: string): Promise<{ graphId: string }> {
  const row = await loadInvite(token);
  if (!row) throw new GraphError(404, "This invite link doesn't work. Ask for a new one.");
  assertOpen(row);
  if (row.i.email !== v.email.toLowerCase()) {
    throw new GraphError(403, `This invite is for ${row.i.email}. Sign in as that person to accept it.`);
  }
  if (row.graphKind === "family") throw new GraphError(400, "This invite can't be used.");
  await db.transaction(async (tx) => {
    const done = await tx.update(graphInvites).set({ acceptedAt: new Date(), acceptedBy: v.id })
      .where(and(eq(graphInvites.id, row.i.id), isNull(graphInvites.acceptedAt), isNull(graphInvites.revokedAt))).returning({ id: graphInvites.id });
    if (!done.length) throw new GraphError(409, "This invite has already been used.");
    const [existing] = await tx.select({ id: graphMembers.id }).from(graphMembers)
      .where(and(eq(graphMembers.graphId, row.i.graphId), eq(graphMembers.userId, v.id)));
    if (!existing) await upsertMember(tx, row.i.graphId, v.id, row.i.role === "owner" ? "editor" : row.i.role, row.i.createdBy);
    await ensureSelfNode(tx, asMember(v), { id: row.i.graphId, kind: row.graphKind, householdId: row.graphHousehold }, { actorId: v.id, note: "Joined with an invite" });
  });
  await writeAudit({ id: v.id, householdId: row.graphHousehold }, "graph.invite_accept", { type: "graph", id: row.i.graphId }, { inviteId: row.i.id, name: v.name });
  return { graphId: row.i.graphId };
}

/**
 * Not signed in: make an account for the invited email in a NEW household of their own (they never join the
 * inviter's household), with their own Personal graph, then join the shared graph. Returns the new user id.
 */
export async function acceptInviteAsNewUser(token: string, input: { name: string; passwordHash: string }): Promise<{ userId: string; graphId: string }> {
  const row = await loadInvite(token);
  if (!row) throw new GraphError(404, "This invite link doesn't work. Ask for a new one.");
  assertOpen(row);
  if (row.graphKind === "family") throw new GraphError(400, "This invite can't be used.");
  const out = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`mygraph:invite:${row.i.id}`}))`);
    const [taken] = await tx.select({ id: users.id }).from(users).where(eq(users.email, row.i.email)).limit(1);
    if (taken) throw new GraphError(409, "An account with this email already exists. Sign in, then open the link again.");
    const done = await tx.update(graphInvites).set({ acceptedAt: new Date() })
      .where(and(eq(graphInvites.id, row.i.id), isNull(graphInvites.acceptedAt), isNull(graphInvites.revokedAt))).returning({ id: graphInvites.id });
    if (!done.length) throw new GraphError(409, "This invite has already been used.");
    const acct = await createAccountWithOwnHousehold(tx, { name: input.name, email: row.i.email, passwordHash: input.passwordHash });
    await upsertMember(tx, row.i.graphId, acct.userId, row.i.role === "owner" ? "editor" : row.i.role, row.i.createdBy);
    await ensureSelfNode(tx, { id: acct.userId, name: input.name, householdId: acct.householdId, role: "owner" },
      { id: row.i.graphId, kind: row.graphKind, householdId: row.graphHousehold }, { actorId: acct.userId, note: "Joined with an invite" });
    await tx.update(graphInvites).set({ acceptedBy: acct.userId }).where(eq(graphInvites.id, row.i.id));
    return acct;
  });
  await writeAudit({ id: out.userId, householdId: out.householdId }, "setup.complete", { type: "household", id: out.householdId }, { via: "invite" });
  await writeAudit({ id: out.userId, householdId: out.householdId }, "graph.create", { type: "graph", id: out.personalId }, { name: "Personal", kind: "personal" });
  await writeAudit({ id: out.userId, householdId: row.graphHousehold }, "graph.invite_accept", { type: "graph", id: row.i.graphId }, { inviteId: row.i.id, name: input.name, newAccount: true });
  return { userId: out.userId, graphId: row.i.graphId };
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * A person who joins through an invite: a household of their own (owner), their own "Personal" graph holding their
 * person node — and no family graph, so nothing of the inviter's household is ever theirs to see.
 */
export async function createAccountWithOwnHousehold(tx: Tx, input: { name: string; email: string; passwordHash: string | null }) {
  const [h] = await tx.insert(households).values({ name: `${input.name}'s home` }).returning({ id: households.id });
  const [personal] = await tx.insert(graphs).values({ householdId: h.id, ownerId: null, name: "Personal", kind: "personal", color: DEFAULT_HUES.personal })
    .returning({ id: graphs.id });
  const acct = await createAccount(tx, {
    householdId: h.id, role: "owner", name: input.name, email: input.email, passwordHash: input.passwordHash, graphId: personal.id,
  }, null);
  await tx.update(graphs).set({ ownerId: acct.userId }).where(eq(graphs.id, personal.id));
  await upsertMember(tx, personal.id, acct.userId, "owner", acct.userId);
  // Their person node lives in the Personal graph: mark it as their self node there.
  await ensureSelfNode(tx, { id: acct.userId, name: input.name, householdId: h.id, role: "owner", personNodeId: acct.personNodeId },
    { id: personal.id, kind: "personal", householdId: h.id });
  return { userId: acct.userId, householdId: h.id, personalId: personal.id, personNodeId: acct.personNodeId };
}

/** The invite's email (for password checks on the new-account form). */
export async function inviteEmail(token: string): Promise<string | null> {
  const row = await loadInvite(token);
  return row?.i.email ?? null;
}
