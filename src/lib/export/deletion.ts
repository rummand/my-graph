/**
 * Deleting an account (server-only). Rules in ./deletion-policy (pure, tested). Flow:
 *   request (typed confirmation) → every session ends, a row in account_deletions with a date 7 days out
 *   sign-in within those 7 days → cancelled (the sweep sees a session newer than the request; auth may also call
 *     cancelIfSignedIn right after a sign-in to cancel at once)
 *   due → executeDeletion: one transaction, re-checking the rules first.
 * What executeDeletion does:
 *   - a stand-in account ("A former member", in the Former members household, can never sign in) is made;
 *   - in every graph that stays (shared with others), what they added for others to see (not private) is handed to
 *     the stand-in: nodes, facts, sources (+ their chunks), wiki pages, artifacts; their name is replaced in history,
 *     revisions, change sets and provenance;
 *   - graphs only they use are deleted; the household too when they own it and are its only member;
 *   - the account is deleted, which removes everything else of theirs (private items, chats, memories, reminders,
 *     connections, passkeys, sessions, AI-app access, plans) through the foreign keys;
 *   - originals no source refers to any more are removed from storage, and their export downloads are deleted.
 * Every step is audit-logged without personal data.
 */
import { rm } from "node:fs/promises";
import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { accountDeletions, auditLog, billingAccounts, connections, dataExports, graphMembers, graphs, households, sessions, sources, users } from "@/db/schema";
import { writeAudit } from "@/lib/auth/audit";
import { isPlatformAdmin } from "@/lib/plans";
import { deleteStored } from "@/lib/storage";
import {
  FORMER_EMAIL_DOMAIN, FORMER_HOUSEHOLD_ID, FORMER_HOUSEHOLD_NAME, FORMER_MEMBER_NAME, confirmationMatches, deletionBlockers,
  deletionDueAt, formerMemberEmail, planDeletion, signedInSince, type Blocker, type DeletionFacts, type GraphFact, type Role,
} from "./deletion-policy";
import { exportFilePath } from "./jobs";

export class DeletionError extends Error {
  constructor(public status: number, message: string, public extra?: Record<string, unknown>) { super(message); this.name = "DeletionError"; }
}

type Exec = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

const notFormer = sql`${users.email} not like ${`%@${FORMER_EMAIL_DOMAIN}`}`;

/* ── Facts and state ─────────────────────────────────────────────────────────────────────────────────── */

export async function deletionFacts(userId: string, ex: Exec = db): Promise<(DeletionFacts & { email: string; householdId: string }) | null> {
  const [u] = await ex.select({ id: users.id, email: users.email, role: users.role, householdId: users.householdId }).from(users).where(eq(users.id, userId));
  if (!u) return null;
  const [{ n }] = await ex.select({ n: sql<number>`count(*)::int` }).from(users)
    .where(and(eq(users.householdId, u.householdId), ne(users.id, u.id), notFormer));
  const owned = await ex.select({ id: graphs.id, name: graphs.name, kind: graphs.kind, householdId: graphs.householdId }).from(graphs).where(eq(graphs.ownerId, u.id));
  const ids = owned.map((g) => g.id);
  const members = ids.length
    ? await ex.select({ graphId: graphMembers.graphId, userId: graphMembers.userId }).from(graphMembers).where(inArray(graphMembers.graphId, ids))
    : [];
  const sharedOwnedGraphs = owned
    // The family graph follows the household (the household rule covers it).
    .filter((g) => !(g.kind === "family" && g.householdId === u.householdId))
    .map((g) => ({ id: g.id, name: g.name, others: members.filter((m) => m.graphId === g.id && m.userId !== u.id).length }));
  return { role: u.role as Role, email: u.email, householdId: u.householdId, isPlatformAdmin: isPlatformAdmin({ email: u.email }), householdOthers: n, sharedOwnedGraphs };
}

export type DeletionState = {
  scheduled: { id: string; requestedAt: Date; scheduledFor: Date } | null;
  /** The most recent finished request (cancelled), to explain what happened. */
  lastCancelled: { cancelledAt: Date; reason: string | null } | null;
  blockers: Blocker[];
  /** Grown-ups in the household who could take it over. */
  heirs: { id: string; name: string }[];
  /** For each shared graph they own: who could take it over. */
  graphHeirs: { graphId: string; graphName: string; members: { id: string; name: string }[] }[];
};

export async function deletionState(userId: string): Promise<DeletionState | null> {
  const f = await deletionFacts(userId);
  if (!f) return null;
  const [scheduled] = await db.select().from(accountDeletions).where(and(eq(accountDeletions.userId, userId), eq(accountDeletions.status, "scheduled"))).limit(1);
  const [cancelled] = await db.select().from(accountDeletions).where(and(eq(accountDeletions.userId, userId), eq(accountDeletions.status, "cancelled")))
    .orderBy(desc(accountDeletions.cancelledAt)).limit(1);
  const heirs = f.role === "owner"
    ? await db.select({ id: users.id, name: users.name }).from(users)
      .where(and(eq(users.householdId, f.householdId), ne(users.id, userId), eq(users.role, "parent"), notFormer)).orderBy(users.name)
    : [];
  const shared = f.sharedOwnedGraphs.filter((g) => g.others > 0);
  const graphHeirs = [];
  for (const g of shared) {
    const members = await db.select({ id: users.id, name: users.name }).from(graphMembers).innerJoin(users, eq(users.id, graphMembers.userId))
      .where(and(eq(graphMembers.graphId, g.id), ne(graphMembers.userId, userId), inArray(graphMembers.role, ["editor", "owner"]), notFormer)).orderBy(users.name);
    graphHeirs.push({ graphId: g.id, graphName: g.name, members });
  }
  return {
    scheduled: scheduled ? { id: scheduled.id, requestedAt: scheduled.requestedAt, scheduledFor: scheduled.scheduledFor } : null,
    lastCancelled: cancelled?.cancelledAt && Date.now() - cancelled.cancelledAt.getTime() < 14 * 86_400_000 ? { cancelledAt: cancelled.cancelledAt, reason: cancelled.cancelReason } : null,
    blockers: deletionBlockers(f), heirs, graphHeirs,
  };
}

/* ── Request, cancel ─────────────────────────────────────────────────────────────────────────────────── */

export function blockerMessage(b: Blocker): string {
  switch (b.code) {
    case "platform_admin": return "The platform admin's account can't be deleted here.";
    case "child": return "Ask a parent to remove your account.";
    case "household_owner": return "You own the household. Hand it to another grown-up first.";
    case "shared_graph_owner": return `Hand ${b.graphs.map((g) => g.name).join(", ")} to someone who uses it, or delete it first.`;
  }
}

/** Ask to delete the account. Ends every session; the deletion happens in 7 days unless they sign in again. */
export async function requestDeletion(userId: string, typed: string): Promise<{ id: string; scheduledFor: Date }> {
  const f = await deletionFacts(userId);
  if (!f) throw new DeletionError(404, "This account doesn't exist.");
  const blockers = deletionBlockers(f);
  if (blockers.length) throw new DeletionError(409, blockerMessage(blockers[0]), { blockers });
  if (!confirmationMatches(typed, f.email)) throw new DeletionError(400, "Type your sign-in email exactly as it is to confirm.", { fields: [{ key: "confirm", message: "That isn't your sign-in email." }] });
  const now = new Date();
  const row = await db.transaction(async (tx) => {
    const [existing] = await tx.select().from(accountDeletions).where(and(eq(accountDeletions.userId, userId), eq(accountDeletions.status, "scheduled")));
    if (existing) return existing;
    const [r] = await tx.insert(accountDeletions).values({ userId, householdId: f.householdId, requestedAt: now, scheduledFor: deletionDueAt(now) }).returning();
    // Signed out everywhere: signing in again is how they change their mind.
    await tx.delete(sessions).where(eq(sessions.userId, userId));
    return r;
  });
  await writeAudit({ id: userId, householdId: f.householdId }, "account.deletion_requested", { type: "user", id: userId }, { scheduledFor: row.scheduledFor.toISOString() });
  return { id: row.id, scheduledFor: row.scheduledFor };
}

export async function cancelDeletion(userId: string, reason: "signed_in" | "by_person" | "blocked"): Promise<boolean> {
  const rows = await db.update(accountDeletions).set({ status: "cancelled", cancelledAt: new Date(), cancelReason: reason })
    .where(and(eq(accountDeletions.userId, userId), eq(accountDeletions.status, "scheduled"))).returning();
  if (!rows.length) return false;
  await writeAudit({ id: userId, householdId: rows[0].householdId }, "account.deletion_cancelled", { type: "user", id: userId }, { reason });
  return true;
}

/** Cancel a pending deletion when the person has signed in since asking (call right after a sign-in). */
export async function cancelIfSignedIn(userId: string): Promise<boolean> {
  const [row] = await db.select().from(accountDeletions).where(and(eq(accountDeletions.userId, userId), eq(accountDeletions.status, "scheduled")));
  if (!row) return false;
  const s = await db.select({ createdAt: sessions.createdAt }).from(sessions).where(and(eq(sessions.userId, userId), eq(sessions.approved, true)));
  if (!signedInSince(s, row.requestedAt)) return false;
  return cancelDeletion(userId, "signed_in");
}

/* ── Handing over ────────────────────────────────────────────────────────────────────────────────────── */

/** Hand the household (and its family graph) to another grown-up in it. The old owner becomes a parent. */
export async function transferHousehold(fromId: string, toId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [from] = await tx.select().from(users).where(eq(users.id, fromId)).for("update");
    const [to] = await tx.select().from(users).where(eq(users.id, toId)).for("update");
    if (!from || from.role !== "owner") throw new DeletionError(403, "Only the household's owner can hand it over.");
    if (!to || to.householdId !== from.householdId || to.id === from.id) throw new DeletionError(400, "Pick someone in your household.");
    if (to.role !== "parent") throw new DeletionError(400, "The household can only go to a parent. Make them a parent under Household first.");
    await tx.update(users).set({ role: "owner" }).where(eq(users.id, to.id));
    await tx.update(users).set({ role: "parent" }).where(eq(users.id, from.id));
    const fam = await tx.select({ id: graphs.id }).from(graphs).where(and(eq(graphs.householdId, from.householdId), eq(graphs.kind, "family")));
    for (const g of fam) {
      await tx.update(graphs).set({ ownerId: to.id }).where(eq(graphs.id, g.id));
      await tx.insert(graphMembers).values({ graphId: g.id, userId: to.id, role: "owner", addedBy: from.id })
        .onConflictDoUpdate({ target: [graphMembers.graphId, graphMembers.userId], set: { role: "owner" } });
      await tx.update(graphMembers).set({ role: "editor" }).where(and(eq(graphMembers.graphId, g.id), eq(graphMembers.userId, from.id)));
    }
  });
  const [u] = await db.select({ householdId: users.householdId }).from(users).where(eq(users.id, fromId));
  if (u) await writeAudit({ id: fromId, householdId: u.householdId }, "household.transfer", { type: "user", id: toId });
}

/**
 * Hand a graph to one of its editors. If they are in another household, the graph and everything in it move to
 * their household (content rows carry the graph's household, which the visibility rules compare against).
 */
export async function transferGraph(fromId: string, graphId: string, toId: string): Promise<void> {
  let movedHousehold = false;
  await db.transaction(async (tx) => {
    const [g] = await tx.select().from(graphs).where(eq(graphs.id, graphId)).for("update");
    if (!g || g.ownerId !== fromId) throw new DeletionError(403, "Only the graph's owner can hand it over.");
    if (g.kind === "family") throw new DeletionError(400, "The family graph goes with the household. Hand over the household instead.");
    const [m] = await tx.select().from(graphMembers).where(and(eq(graphMembers.graphId, graphId), eq(graphMembers.userId, toId)));
    if (!m || toId === fromId) throw new DeletionError(400, "Pick someone who is in this graph.");
    const [to] = await tx.select({ householdId: users.householdId }).from(users).where(eq(users.id, toId));
    await tx.update(graphs).set({ ownerId: toId }).where(eq(graphs.id, graphId));
    await tx.update(graphMembers).set({ role: "owner" }).where(and(eq(graphMembers.graphId, graphId), eq(graphMembers.userId, toId)));
    await tx.update(graphMembers).set({ role: "editor" }).where(and(eq(graphMembers.graphId, graphId), eq(graphMembers.userId, fromId)));
    if (to && to.householdId !== g.householdId) {
      movedHousehold = true;
      await tx.update(graphs).set({ householdId: to.householdId }).where(eq(graphs.id, graphId));
      const tables = await tx.execute<{ t: string }>(sql`
        select c1.table_name as t from information_schema.columns c1
        join information_schema.columns c2 on c2.table_schema = c1.table_schema and c2.table_name = c1.table_name and c2.column_name = 'household_id'
        join information_schema.tables tb on tb.table_schema = c1.table_schema and tb.table_name = c1.table_name and tb.table_type = 'BASE TABLE'
        where c1.table_schema = 'public' and c1.column_name = 'graph_id' and c1.table_name <> 'graphs'`);
      for (const { t } of tables) {
        if (!/^[a-z_][a-z0-9_]*$/.test(t)) continue;
        await tx.execute(sql`update ${sql.identifier(t)} set household_id = ${to.householdId} where graph_id = ${graphId}`);
      }
    }
  });
  const [u] = await db.select({ householdId: users.householdId }).from(users).where(eq(users.id, fromId));
  if (u) await writeAudit({ id: fromId, householdId: u.householdId }, "graph.transfer", { type: "graph", id: graphId }, { to: toId, movedHousehold });
}

/* ── Carrying it out ─────────────────────────────────────────────────────────────────────────────────── */

async function ensureFormerHousehold(tx: Exec): Promise<void> {
  await tx.insert(households).values({ id: FORMER_HOUSEHOLD_ID, name: FORMER_HOUSEHOLD_NAME }).onConflictDoNothing();
}

/** Run one due deletion. Returns what happened. */
export async function executeDeletion(deletionId: string): Promise<"done" | "cancelled" | "blocked" | "skipped"> {
  const keysToCheck = new Set<string>();
  let exportIds: string[] = [];
  let outcome = "skipped" as "done" | "cancelled" | "blocked" | "skipped";
  let householdId = "";
  let userId = "";
  let summary: Record<string, unknown> = {};
  // Read before the account (and these rows) go, acted on after the commit: a paid subscription to stop, and
  // provider sign-ins to hand back.
  let subscription: { id: string; status: string | null } | null = null;
  let connRows: { id: string; connector: string; label: string; config: Record<string, unknown> | null; secrets: string | null }[] = [];

  await db.transaction(async (tx) => {
    const [row] = await tx.select().from(accountDeletions).where(eq(accountDeletions.id, deletionId)).for("update", { skipLocked: true });
    if (!row || row.status !== "scheduled" || row.scheduledFor.getTime() > Date.now()) return;
    userId = row.userId;
    householdId = row.householdId;
    await tx.update(accountDeletions).set({ attempts: row.attempts + 1 }).where(eq(accountDeletions.id, row.id));

    const s = await tx.select({ createdAt: sessions.createdAt }).from(sessions).where(and(eq(sessions.userId, row.userId), eq(sessions.approved, true)));
    if (signedInSince(s, row.requestedAt)) {
      await tx.update(accountDeletions).set({ status: "cancelled", cancelledAt: new Date(), cancelReason: "signed_in" }).where(eq(accountDeletions.id, row.id));
      outcome = "cancelled";
      return;
    }
    const f = await deletionFacts(row.userId, tx);
    if (!f) {
      await tx.update(accountDeletions).set({ status: "done", completedAt: new Date(), summary: { alreadyGone: true } }).where(eq(accountDeletions.id, row.id));
      outcome = "done";
      return;
    }
    const blockers = deletionBlockers(f);
    if (blockers.length) {
      await tx.update(accountDeletions).set({ status: "cancelled", cancelledAt: new Date(), cancelReason: "blocked", error: blockerMessage(blockers[0]) }).where(eq(accountDeletions.id, row.id));
      outcome = "blocked";
      return;
    }

    // Graphs they are in or own, with their members.
    const memberOf = await tx.select({ graphId: graphMembers.graphId }).from(graphMembers).where(eq(graphMembers.userId, row.userId));
    const owned = await tx.select({ id: graphs.id }).from(graphs).where(eq(graphs.ownerId, row.userId));
    const gids = [...new Set([...memberOf.map((m) => m.graphId), ...owned.map((g) => g.id)])];
    const gRows = gids.length ? await tx.select({ id: graphs.id, ownerId: graphs.ownerId, kind: graphs.kind, householdId: graphs.householdId }).from(graphs).where(inArray(graphs.id, gids)) : [];
    const mRows = gids.length ? await tx.select({ graphId: graphMembers.graphId, userId: graphMembers.userId }).from(graphMembers).where(inArray(graphMembers.graphId, gids)) : [];
    const facts: GraphFact[] = gRows.map((g) => ({ ...g, members: mRows.filter((m) => m.graphId === g.id).map((m) => m.userId) }));
    const plan = planDeletion(row.userId, f.role, f.householdId, f.householdOthers, facts);
    const deleteIds = plan.deleteGraphIds;
    // Content of theirs in graphs they've already left counts as "kept" too: everything not in a deleted graph.
    const keptGraph = deleteIds.length ? sql`graph_id <> all(${sql`array[${sql.join(deleteIds.map((id) => sql`${id}::uuid`), sql`, `)}]`})` : sql`true`;

    // 1. The stand-in.
    await ensureFormerHousehold(tx);
    const [former] = await tx.insert(users).values({
      householdId: FORMER_HOUSEHOLD_ID, email: formerMemberEmail(crypto.randomUUID()), name: FORMER_MEMBER_NAME, role: "guest",
      passwordHash: null, accessExpiresAt: new Date(0), locale: "en",
    }).returning({ id: users.id });

    // 2. Hand over what others can see, in graphs that stay.
    const u = row.userId;
    const fid = former.id;
    const moved: Record<string, number> = {};
    for (const t of ["nodes", "edges", "sources", "wiki_pages", "artifacts"] as const) {
      const r = await tx.execute(sql`update ${sql.identifier(t)} set owner_id = ${fid} where owner_id = ${u} and visibility <> 'private' and ${keptGraph}`);
      moved[t] = (r as unknown as { count?: number }).count ?? 0;
    }
    await tx.execute(sql`update chunks set owner_id = ${fid} where owner_id = ${u} and source_id in (select id from sources where owner_id = ${fid})`);
    await tx.execute(sql`update provenance set agent_id = ${fid}::text where agent_type = 'user' and agent_id = ${u}::text and ${keptGraph}`);
    await tx.execute(sql`update wiki_pages set updated_by = ${fid} where updated_by = ${u}`);
    await tx.execute(sql`update wiki_revisions set author_id = ${fid} where author_id = ${u}`);
    await tx.execute(sql`update graph_events set actor_id = ${fid}, actor_name = ${FORMER_MEMBER_NAME} where actor_id = ${u}`);
    await tx.execute(sql`update changes set author_id = ${fid}, author_name = ${FORMER_MEMBER_NAME} where author_id = ${u}`);
    await tx.execute(sql`update change_sets set created_by = ${fid} where created_by = ${u} and ${keptGraph}`);
    await tx.execute(sql`update mentions set created_by = ${fid} where created_by = ${u}`);
    await tx.execute(sql`update checkpoints set created_by = ${fid} where created_by = ${u}`);
    await tx.execute(sql`update artifact_versions set created_by = ${fid} where created_by = ${u}`);

    // 3. Files that may become unreferenced (checked after commit).
    const goingSources = await tx.select({ key: sources.storageKey }).from(sources)
      .where(sql`${sources.storageKey} is not null and (${sources.ownerId} = ${u}${deleteIds.length ? sql` or ${inArray(sources.graphId, deleteIds)}` : sql``})`);
    for (const s2 of goingSources) if (s2.key) keysToCheck.add(s2.key);
    exportIds = (await tx.select({ id: dataExports.id }).from(dataExports).where(eq(dataExports.userId, u))).map((e) => e.id);
    const [bill] = await tx.select({ sub: billingAccounts.stripeSubscriptionId, status: billingAccounts.status }).from(billingAccounts).where(eq(billingAccounts.userId, u));
    subscription = bill?.sub ? { id: bill.sub, status: bill.status } : null;
    connRows = await tx.select({ id: connections.id, connector: connections.connector, label: connections.label, config: connections.config, secrets: connections.secrets })
      .from(connections).where(eq(connections.userId, u));

    // 4. Graphs only they use, then the account (or the whole household).
    if (deleteIds.length) await tx.delete(graphs).where(inArray(graphs.id, deleteIds));
    if (plan.deleteHousehold) await tx.delete(households).where(eq(households.id, f.householdId));
    else await tx.delete(users).where(eq(users.id, u));

    summary = { keptAsFormerMember: moved, graphsDeleted: deleteIds.length, householdDeleted: plan.deleteHousehold, graphsKept: plan.keepGraphIds.length };
    await tx.update(accountDeletions).set({ status: "done", completedAt: new Date(), formerId: fid, summary, error: null }).where(eq(accountDeletions.id, row.id));
    // Audit (written inside the transaction so it can't be lost; no name or email).
    await tx.insert(auditLog).values({ householdId: f.householdId, userId: u, action: "account.deleted", targetType: "user", targetId: u, meta: { ...summary, formerId: fid } });
    outcome = "done";
  });

  if (outcome === "blocked") await writeAudit({ id: userId, householdId }, "account.deletion_cancelled", { type: "user", id: userId }, { reason: "blocked" });
  if (outcome === "cancelled") await writeAudit({ id: userId, householdId }, "account.deletion_cancelled", { type: "user", id: userId }, { reason: "signed_in" });
  if (outcome === "done") {
    await afterDeletion(userId, householdId, subscription, connRows);
    for (const id of exportIds) await rm(exportFilePath(id), { force: true }).catch(() => {});
    for (const key of keysToCheck) {
      const [still] = await db.select({ id: sources.id }).from(sources).where(eq(sources.storageKey, key)).limit(1);
      if (!still) await deleteStored(key).catch(() => {});
    }
  }
  return outcome;
}

/**
 * After the account is gone: stop its Stripe subscription (so nobody is charged for a deleted account) and hand its
 * connections' sign-ins back to the providers. Never throws; a failure is audit-logged (ids only) for the admin.
 */
async function afterDeletion(
  userId: string, householdId: string, subscription: { id: string; status: string | null } | null,
  connRows: { id: string; connector: string; label: string; config: Record<string, unknown> | null; secrets: string | null }[],
): Promise<void> {
  const ENDED = new Set(["canceled", "incomplete_expired"]);
  if (subscription && !ENDED.has(subscription.status ?? "")) {
    try {
      const { cancelSubscriptionNow } = await import("@/lib/billing");
      const r = await cancelSubscriptionNow(subscription.id);
      await writeAudit({ id: userId, householdId }, "account.deleted.billing", { type: "user", id: userId }, { subscription: subscription.id, result: r }).catch(() => {});
    } catch (e) {
      console.error("[deletion] cancelling the subscription failed", subscription.id, e instanceof Error ? e.message : e);
      await writeAudit({ id: userId, householdId }, "account.deleted.billing_failed", { type: "user", id: userId }, { subscription: subscription.id }).catch(() => {});
    }
  }
  if (connRows.length) {
    const [{ revokeConnection }, { decryptSecrets }, { guardedTransport }] = await Promise.all([
      import("@/lib/connectors/revoke"), import("@/lib/connectors/crypto"), import("@/lib/mcp-client/transport"),
    ]);
    for (const c of connRows) {
      let secrets: Record<string, string> = {};
      try { secrets = decryptSecrets(c.secrets, c.id); } catch { continue; }
      await revokeConnection(c, secrets, guardedTransport()).catch(() => null);
    }
  }
}

/** Cancel the ones who signed in; carry out the ones whose grace period is over. */
export async function sweepDeletions(now = new Date()): Promise<void> {
  const pending = await db.select({ id: accountDeletions.id, userId: accountDeletions.userId, scheduledFor: accountDeletions.scheduledFor, attempts: accountDeletions.attempts })
    .from(accountDeletions).where(and(eq(accountDeletions.status, "scheduled"), isNull(accountDeletions.cancelledAt))).limit(200);
  for (const p of pending) {
    try {
      if (await cancelIfSignedIn(p.userId)) continue;
      if (p.scheduledFor.getTime() > now.getTime()) continue;
      await executeDeletion(p.id);
    } catch (e) {
      const msg = e instanceof Error ? e.message.slice(0, 500) : String(e);
      console.error("[deletion] failed", p.id, msg);
      // Retried on the next sweep; after 5 tries it stops and says so (an admin looks at it).
      await db.update(accountDeletions).set({ error: msg, attempts: sql`${accountDeletions.attempts} + 1`, ...(p.attempts + 1 >= 5 ? { status: "failed" } : {}) })
        .where(eq(accountDeletions.id, p.id)).catch(() => {});
    }
  }
}

/** For the admin page: deletions waiting or failed. */
export async function pendingDeletions(): Promise<{ scheduled: number; failed: number; nextAt: Date | null }> {
  const rows = await db.select({ status: accountDeletions.status, scheduledFor: accountDeletions.scheduledFor }).from(accountDeletions)
    .where(inArray(accountDeletions.status, ["scheduled", "failed"]));
  const scheduled = rows.filter((r) => r.status === "scheduled");
  return {
    scheduled: scheduled.length, failed: rows.filter((r) => r.status === "failed").length,
    nextAt: scheduled.length ? new Date(Math.min(...scheduled.map((r) => r.scheduledFor.getTime()))) : null,
  };
}

