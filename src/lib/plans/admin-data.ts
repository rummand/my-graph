/**
 * Reads for the platform admin console (server-only). Metadata only: names, emails, roles, plans, counts and sizes.
 * Nothing here reads graph content (no node labels, page text, file names or messages).
 */
import { and, asc, desc, eq, ilike, inArray, like, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { accountAddons, accountControls, accountPlans, auditLog, graphMembers, graphs, households, passkeys, sessions, users } from "@/db/schema";
import { effectivePlan, emailIsAdmin } from "./catalog";
import { adminEmails } from "./store";
import { FORMER_EMAIL_DOMAIN, FORMER_HOUSEHOLD_ID } from "@/lib/export/deletion-policy";

/** Stand-ins for deleted accounts ("A former member") are not people: they stay out of the lists and totals. */
const realUser = sql`${users.email} not like ${`%@${FORMER_EMAIL_DOMAIN}`}`;
const realHousehold = sql`${households.id} <> ${FORMER_HOUSEHOLD_ID}::uuid`;

const lastActive = sql<string | null>`greatest(
  (select max(s.last_seen_at) from sessions s where s.user_id = ${users.id}),
  (select max(a.at) from audit_log a where a.user_id = ${users.id} and a.action = 'auth.login'))`;
const ownedGraphs = sql<number>`(select count(*)::int from graphs g where g.owner_id = ${users.id} and g.archived_at is null)`;
const ownedSources = sql<number>`(select count(*)::int from sources s where s.owner_id = ${users.id})`;
const ownedBytes = sql<number>`(select coalesce(sum(s.size), 0)::float8 from sources s where s.owner_id = ${users.id})`;

function iso(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  return (d instanceof Date ? d : new Date(d)).toISOString();
}

function escapeLike(q: string): string {
  return q.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export type AccountRow = {
  id: string; name: string; email: string; role: string; householdId: string; householdName: string;
  planKey: string; planInherited: boolean; ownPlan: string | null; addons: string[];
  createdAt: string; lastActiveAt: string | null; graphs: number; sources: number; bytes: number;
  locked: boolean; isPlatformAdmin: boolean;
};

/** Accounts, newest first, matching a search over name, email and household name. */
export async function listAccounts(opts: { q?: string; limit?: number } = {}): Promise<AccountRow[]> {
  const q = opts.q?.trim();
  const pattern = q ? `%${escapeLike(q)}%` : null;
  const rows = await db.select({
    id: users.id, name: users.name, email: users.email, role: users.role, householdId: users.householdId,
    householdName: households.name, ownPlan: accountPlans.planKey, createdAt: users.createdAt, lockedAt: accountControls.lockedAt,
    lastActive, graphs: ownedGraphs, sources: ownedSources, bytes: ownedBytes,
  }).from(users)
    .innerJoin(households, eq(households.id, users.householdId))
    .leftJoin(accountPlans, eq(accountPlans.userId, users.id))
    .leftJoin(accountControls, eq(accountControls.userId, users.id))
    .where(and(realUser, pattern ? or(ilike(users.name, pattern), ilike(users.email, pattern), ilike(households.name, pattern)) : undefined))
    .orderBy(desc(users.createdAt)).limit(Math.min(opts.limit ?? 200, 500));
  return withPlans(rows);
}

async function withPlans(rows: {
  id: string; name: string; email: string; role: string; householdId: string; householdName: string; ownPlan: string | null;
  createdAt: Date; lockedAt: Date | null; lastActive: string | Date | null; graphs: number; sources: number; bytes: number;
}[]): Promise<AccountRow[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const hh = [...new Set(rows.map((r) => r.householdId))];
  const [addons, owners] = await Promise.all([
    db.select({ userId: accountAddons.userId, addon: accountAddons.addon }).from(accountAddons).where(inArray(accountAddons.userId, ids)),
    db.select({ householdId: users.householdId, planKey: accountPlans.planKey }).from(users)
      .innerJoin(accountPlans, eq(accountPlans.userId, users.id))
      .where(and(inArray(users.householdId, hh), eq(users.role, "owner"))),
  ]);
  const ownerPlan = new Map(owners.map((o) => [o.householdId, o.planKey]));
  const admins = adminEmails();
  return rows.map((r) => {
    const eff = effectivePlan(r.ownPlan, ownerPlan.get(r.householdId));
    return {
      id: r.id, name: r.name, email: r.email, role: r.role, householdId: r.householdId, householdName: r.householdName,
      planKey: eff.key, planInherited: eff.inherited, ownPlan: r.ownPlan,
      addons: addons.filter((a) => a.userId === r.id).map((a) => a.addon).sort(),
      createdAt: r.createdAt.toISOString(), lastActiveAt: iso(r.lastActive),
      graphs: Number(r.graphs), sources: Number(r.sources), bytes: Number(r.bytes),
      locked: !!r.lockedAt, isPlatformAdmin: emailIsAdmin(r.email, admins),
    };
  });
}

export type AccountDetail = AccountRow & {
  lockedAt: string | null; lockReason: string | null; tempPasswordPending: boolean; hasPassword: boolean;
  passkeys: number; activeSessions: number;
  members: { id: string; name: string; role: string }[];
  recent: AdminAuditRow[];
};

export async function accountDetail(id: string): Promise<AccountDetail | null> {
  const [row] = await db.select({
    id: users.id, name: users.name, email: users.email, role: users.role, householdId: users.householdId,
    householdName: households.name, ownPlan: accountPlans.planKey, createdAt: users.createdAt, lockedAt: accountControls.lockedAt,
    lastActive, graphs: ownedGraphs, sources: ownedSources, bytes: ownedBytes,
    lockReason: accountControls.lockReason, tempPasswordHash: accountControls.tempPasswordHash, passwordHash: users.passwordHash,
  }).from(users)
    .innerJoin(households, eq(households.id, users.householdId))
    .leftJoin(accountPlans, eq(accountPlans.userId, users.id))
    .leftJoin(accountControls, eq(accountControls.userId, users.id))
    .where(eq(users.id, id)).limit(1);
  if (!row) return null;
  const [[base], pk, sess, members, recent] = await Promise.all([
    withPlans([row]),
    db.select({ n: sql<number>`count(*)::int` }).from(passkeys).where(eq(passkeys.userId, id)),
    db.select({ n: sql<number>`count(*)::int` }).from(sessions).where(and(eq(sessions.userId, id), sql`${sessions.expiresAt} > now()`)),
    db.select({ id: users.id, name: users.name, role: users.role }).from(users).where(eq(users.householdId, row.householdId)).orderBy(asc(users.createdAt)),
    adminAudit({ targetId: id, limit: 20 }),
  ]);
  return {
    ...base, lockedAt: iso(row.lockedAt), lockReason: row.lockReason,
    tempPasswordPending: !!row.tempPasswordHash && row.tempPasswordHash === row.passwordHash,
    hasPassword: !!row.passwordHash, passkeys: pk[0]?.n ?? 0, activeSessions: sess[0]?.n ?? 0,
    members: members.filter((m) => m.id !== id), recent,
  };
}

export type HouseholdRow = {
  id: string; name: string; createdAt: string; members: number; ownerId: string | null; ownerName: string | null;
  ownerEmail: string | null; planKey: string; graphs: number; sources: number; bytes: number;
};

export async function listHouseholds(opts: { q?: string } = {}): Promise<HouseholdRow[]> {
  const q = opts.q?.trim();
  const rows = await db.select({
    id: households.id, name: households.name, createdAt: households.createdAt,
    members: sql<number>`(select count(*)::int from users u where u.household_id = ${households.id})`,
    graphs: sql<number>`(select count(*)::int from graphs g where g.household_id = ${households.id} and g.archived_at is null)`,
    sources: sql<number>`(select count(*)::int from sources s where s.household_id = ${households.id})`,
    bytes: sql<number>`(select coalesce(sum(s.size), 0)::float8 from sources s where s.household_id = ${households.id})`,
  }).from(households).where(and(realHousehold, q ? ilike(households.name, `%${escapeLike(q)}%`) : undefined)).orderBy(desc(households.createdAt)).limit(500);
  if (!rows.length) return [];
  const owners = await db.select({ householdId: users.householdId, id: users.id, name: users.name, email: users.email, planKey: accountPlans.planKey })
    .from(users).leftJoin(accountPlans, eq(accountPlans.userId, users.id))
    .where(and(inArray(users.householdId, rows.map((r) => r.id)), eq(users.role, "owner")));
  return rows.map((r) => {
    const o = owners.find((x) => x.householdId === r.id);
    return {
      id: r.id, name: r.name, createdAt: r.createdAt.toISOString(), members: Number(r.members),
      ownerId: o?.id ?? null, ownerName: o?.name ?? null, ownerEmail: o?.email ?? null, planKey: o?.planKey ?? "free",
      graphs: Number(r.graphs), sources: Number(r.sources), bytes: Number(r.bytes),
    };
  });
}

export type GraphRow = {
  id: string; name: string; kind: string; householdName: string; ownerId: string | null; ownerName: string | null;
  members: number; nodes: number; sources: number; bytes: number; createdAt: string; archived: boolean;
};

export async function listGraphs(opts: { q?: string } = {}): Promise<GraphRow[]> {
  const q = opts.q?.trim();
  const pattern = q ? `%${escapeLike(q)}%` : null;
  const rows = await db.select({
    id: graphs.id, name: graphs.name, kind: graphs.kind, createdAt: graphs.createdAt, archivedAt: graphs.archivedAt,
    householdName: households.name, ownerId: graphs.ownerId, ownerName: users.name,
    members: sql<number>`(select count(*)::int from graph_members m where m.graph_id = ${graphs.id})`,
    nodes: sql<number>`(select count(*)::int from nodes n where n.graph_id = ${graphs.id})`,
    sources: sql<number>`(select count(*)::int from sources s where s.graph_id = ${graphs.id})`,
    bytes: sql<number>`(select coalesce(sum(s.size), 0)::float8 from sources s where s.graph_id = ${graphs.id})`,
  }).from(graphs)
    .innerJoin(households, eq(households.id, graphs.householdId))
    .leftJoin(users, eq(users.id, graphs.ownerId))
    .where(pattern ? or(ilike(graphs.name, pattern), ilike(households.name, pattern), ilike(users.name, pattern)) : undefined)
    .orderBy(desc(graphs.createdAt)).limit(500);
  return rows.map((r) => ({
    id: r.id, name: r.name, kind: r.kind, householdName: r.householdName, ownerId: r.ownerId, ownerName: r.ownerName,
    members: Number(r.members), nodes: Number(r.nodes), sources: Number(r.sources), bytes: Number(r.bytes),
    createdAt: r.createdAt.toISOString(), archived: !!r.archivedAt,
  }));
}

export type AdminAuditRow = {
  id: string; at: string; action: string; adminId: string | null; adminName: string | null;
  targetType: string | null; targetId: string | null; targetName: string | null; meta: Record<string, unknown>;
};

/** Admin actions (every `admin.*` entry), newest first. */
export async function adminAudit(opts: { targetId?: string; limit?: number } = {}): Promise<AdminAuditRow[]> {
  const rows = await db.select().from(auditLog)
    .where(and(like(auditLog.action, "admin.%"), opts.targetId ? eq(auditLog.targetId, opts.targetId) : undefined))
    .orderBy(desc(auditLog.at)).limit(Math.min(opts.limit ?? 200, 1000));
  const ids = [...new Set(rows.flatMap((r) => [r.userId, r.targetType === "user" ? r.targetId : null]).filter((x): x is string => !!x))];
  const names = new Map(ids.length ? (await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids))).map((u) => [u.id, u.name]) : []);
  return rows.map((r) => ({
    id: r.id, at: r.at.toISOString(), action: r.action, adminId: r.userId, adminName: r.userId ? names.get(r.userId) ?? null : null,
    targetType: r.targetType, targetId: r.targetId,
    targetName: r.targetType === "user" && r.targetId ? names.get(r.targetId) ?? (r.meta?.targetEmail as string | undefined) ?? null : null,
    meta: r.meta ?? {},
  }));
}

/** Numbers for the console's header. */
export async function adminTotals() {
  const [[u], [h], [gr], [m]] = await Promise.all([
    db.select({ n: sql<number>`count(*)::int` }).from(users).where(realUser),
    db.select({ n: sql<number>`count(*)::int` }).from(households).where(realHousehold),
    db.select({ n: sql<number>`count(*)::int` }).from(graphs).where(sql`${graphs.archivedAt} is null`),
    db.select({ n: sql<number>`count(distinct ${graphMembers.userId})::int` }).from(graphMembers),
  ]);
  return { accounts: u?.n ?? 0, households: h?.n ?? 0, graphs: gr?.n ?? 0, graphMembers: m?.n ?? 0 };
}
