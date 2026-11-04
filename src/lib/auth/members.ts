/**
 * Creating accounts: a user row, their own person node (in their household's family graph), and — for children — a
 * parent_of fact in the parent's brain. Written directly with drizzle (not through GBrain) so setup and the seed
 * script work on an empty database; every node and edge still gets a provenance row (activity manual_edit, agent the
 * acting user). Every new household member joins the household's family graph.
 */
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { edges, households, nodes, provenance, users } from "@/db/schema";
import { familyGraphRole } from "@/lib/graphs/pure";
import { emailIsAdmin, parseAdminEmails } from "@/lib/plans/catalog";
import { ensureFamilyGraph, upsertMember } from "@/lib/graphs/store";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type Exec = typeof db | Tx;

export type Role = "owner" | "parent" | "child" | "guest";

/** Meta-model person kind for a member's own node. */
export function personKindFor(role: Role): string | null {
  return role === "child" ? "child" : null;
}

/** Who may see a member's own person node: everyone in the household, except guests (private to themselves). */
export function personVisibilityFor(role: Role): "household" | "private" {
  return role === "guest" ? "private" : "household";
}

/** Which roles the acting member may create or manage. Owners manage everyone but themselves; parents manage children and guests. */
export function canManageRole(actor: Role, target: Role): boolean {
  if (target === "owner") return false;
  if (actor === "owner") return true;
  if (actor === "parent") return target === "child" || target === "guest";
  return false;
}

async function addProvenance(tx: Exec, householdId: string, graphId: string, subjectType: "node" | "edge", subjectId: string, agentId: string, note: string) {
  await tx.insert(provenance).values({
    householdId, graphId, subjectType, subjectId, activity: "manual_edit", agentType: "user", agentId, confidence: 1, note,
  });
}

/**
 * A member's own person node. It lives in `graphId` — the household's family graph unless given (an account made
 * from an invite has no family graph; its person node goes into its own Personal graph).
 */
export async function createPersonNode(tx: Exec, p: {
  householdId: string; ownerId: string; label: string; role: Role; birthYear?: number | null; agentId: string; note: string; graphId?: string;
}): Promise<string> {
  const props: Record<string, unknown> = { householdMember: true };
  if (p.birthYear) props.birthYear = p.birthYear;
  const graphId = p.graphId ?? (await ensureFamilyGraph(tx, p.householdId, null));
  const [row] = await tx.insert(nodes).values({
    householdId: p.householdId, graphId, ownerId: p.ownerId, type: "person", kind: personKindFor(p.role), label: p.label,
    props, visibility: personVisibilityFor(p.role),
  }).returning({ id: nodes.id });
  await addProvenance(tx, p.householdId, graphId, "node", row.id, p.agentId, p.note);
  return row.id;
}

/** parent_of from the parent's person node to the child's, owned by the parent (idempotent). Both must share a graph. */
export async function linkParentOf(tx: Exec, p: {
  householdId: string; parentUserId: string; parentNodeId: string; childNodeId: string; agentId: string; note: string;
}): Promise<string> {
  const [existing] = await tx.select({ id: edges.id }).from(edges).where(and(
    eq(edges.ownerId, p.parentUserId), eq(edges.fromId, p.parentNodeId), eq(edges.toId, p.childNodeId), eq(edges.relation, "parent_of"),
  )).limit(1);
  if (existing) return existing.id;
  const [child] = await tx.select({ graphId: nodes.graphId }).from(nodes).where(eq(nodes.id, p.childNodeId));
  const [parent] = await tx.select({ graphId: nodes.graphId }).from(nodes).where(eq(nodes.id, p.parentNodeId));
  if (!child || !parent || child.graphId !== parent.graphId) throw new Error("A parent_of fact needs two person nodes in the same graph.");
  const graphId = child.graphId;
  const [row] = await tx.insert(edges).values({
    householdId: p.householdId, graphId, ownerId: p.parentUserId, fromId: p.parentNodeId, toId: p.childNodeId,
    relation: "parent_of", status: "confirmed", confidence: 1, visibility: "household",
  }).returning({ id: edges.id });
  await addProvenance(tx, p.householdId, graphId, "edge", row.id, p.agentId, p.note);
  return row.id;
}

export type NewAccount = {
  householdId: string; role: Role; name: string; email: string; passwordHash: string | null;
  birthYear?: number | null; accessExpiresAt?: Date | null;
  /** Put the person node in this graph instead of the household's family graph (and don't create a family graph). */
  graphId?: string;
};

/** Insert a user and their person node, and point users.personNodeId at it. The user joins the family graph. */
export async function createAccount(tx: Exec, a: NewAccount, actingUserId: string | null): Promise<{ userId: string; personNodeId: string }> {
  const [u] = await tx.insert(users).values({
    householdId: a.householdId, role: a.role, name: a.name, email: a.email.toLowerCase(), passwordHash: a.passwordHash,
    birthYear: a.birthYear ?? null,
    accessExpiresAt: a.role === "guest" ? a.accessExpiresAt ?? null : null,
  }).returning({ id: users.id });
  const agentId = actingUserId ?? u.id;
  let graphId = a.graphId;
  if (!graphId) {
    graphId = await ensureFamilyGraph(tx, a.householdId, a.role === "owner" ? u.id : actingUserId);
    await upsertMember(tx, graphId, u.id, familyGraphRole(a.role), actingUserId);
  }
  const personNodeId = await createPersonNode(tx, {
    householdId: a.householdId, graphId, ownerId: u.id, label: a.name, role: a.role, birthYear: a.birthYear, agentId,
    note: actingUserId && actingUserId !== u.id ? "Added as a family member in Family settings" : "Created with the account",
  });
  await tx.update(users).set({ personNodeId }).where(eq(users.id, u.id));
  return { userId: u.id, personNodeId };
}

/** First run: household + owner + the household's Family graph. Fails if any user exists (checked under an advisory lock). */
export async function createHouseholdWithOwner(input: { householdName: string; name: string; email: string; passwordHash: string }) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"mygraph:setup"}))`);
    const [any] = await tx.select({ id: users.id }).from(users).limit(1);
    if (any) return null;
    const [h] = await tx.insert(households).values({ name: input.householdName }).returning({ id: households.id });
    const acct = await createAccount(tx, {
      householdId: h.id, role: "owner", name: input.name, email: input.email, passwordHash: input.passwordHash,
    }, null);
    return { householdId: h.id, ...acct };
  });
}

export async function emailTaken(email: string, exceptUserId?: string): Promise<boolean> {
  const [row] = await db.select({ id: users.id }).from(users).where(eq(users.email, email.toLowerCase())).limit(1);
  if (row) return row.id !== exceptUserId;
  // Platform admin addresses are reserved: an email is the admin identity, so nobody may take one by creating a
  // member or changing an email. Only first-run setup (or the seed) can create the account that holds it.
  return emailIsAdmin(email, parseAdminEmails(process.env.PLATFORM_ADMIN_EMAILS));
}
