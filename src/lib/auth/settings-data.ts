/** Reads for the settings pages (server-only). Every function is scoped to the viewer's household. */
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { auditLog, graphMembers, households, passkeys, users } from "@/db/schema";
import { auditVisibleTo } from "./audit-labels";
import type { Viewer } from "./index";
import { canManageRole } from "./members";
import { describeUserAgent } from "./session";
import { listSessions } from "./store";

export type SessionView = {
  id: string; device: string; approved: boolean; current: boolean; createdAt: string; lastSeenAt: string;
};

function sessionView(s: Awaited<ReturnType<typeof listSessions>>[number], currentId: string | null): SessionView {
  return {
    id: s.id, device: describeUserAgent(s.userAgent), approved: s.approved, current: s.id === currentId,
    createdAt: s.createdAt.toISOString(), lastSeenAt: s.lastSeenAt.toISOString(),
  };
}

export async function myAccount(v: Viewer) {
  const [u] = await db.select({ hasPassword: users.passwordHash, createdAt: users.createdAt }).from(users).where(eq(users.id, v.id));
  const [h] = await db.select({ name: households.name }).from(households).where(eq(households.id, v.householdId));
  return { hasPassword: !!u?.hasPassword, createdAt: u?.createdAt.toISOString() ?? null, householdName: h?.name ?? "" };
}

export async function myPasskeys(v: Viewer) {
  const rows = await db.select({ id: passkeys.id, name: passkeys.name, createdAt: passkeys.createdAt }).from(passkeys)
    .where(eq(passkeys.userId, v.id)).orderBy(asc(passkeys.createdAt));
  return rows.map((p) => ({ id: p.id, name: p.name ?? "Passkey", createdAt: p.createdAt.toISOString() }));
}

export async function mySessions(v: Viewer, currentSessionId: string | null): Promise<SessionView[]> {
  return (await listSessions([v.id])).map((s) => sessionView(s, currentSessionId));
}

export type MemberView = {
  id: string; name: string; email: string; role: Viewer["role"]; birthYear: number | null; accessExpiresAt: string | null;
  canSignIn: boolean; passkeyCount: number; personNodeId: string | null; isYou: boolean; canManage: boolean;
  sessions: SessionView[];
};

export async function familyMembers(v: Viewer): Promise<MemberView[]> {
  const rows = await db.select().from(users).where(eq(users.householdId, v.householdId)).orderBy(asc(users.createdAt));
  const ids = rows.map((r) => r.id);
  const [pks, sess] = await Promise.all([
    ids.length ? db.select({ userId: passkeys.userId }).from(passkeys).where(inArray(passkeys.userId, ids)) : [],
    listSessions(ids),
  ]);
  const order: Record<string, number> = { owner: 0, parent: 1, child: 2, guest: 3 };
  return rows.map((u) => ({
    id: u.id, name: u.name, email: u.email, role: u.role, birthYear: u.birthYear,
    accessExpiresAt: u.accessExpiresAt?.toISOString() ?? null,
    canSignIn: !!u.passwordHash || pks.some((p) => p.userId === u.id),
    passkeyCount: pks.filter((p) => p.userId === u.id).length,
    personNodeId: u.personNodeId, isYou: u.id === v.id,
    canManage: u.id !== v.id && canManageRole(v.role, u.role),
    sessions: sess.filter((s) => s.userId === u.id).map((s) => sessionView(s, null)),
  })).sort((a, b) => order[a.role] - order[b.role] || a.name.localeCompare(b.name));
}

export type AuditView = {
  id: string; at: string; action: string; actor: string | null; targetType: string | null; targetId: string | null;
  meta: Record<string, unknown>;
};

export async function recentAudit(v: Viewer, opts: { limit?: number; userId?: string } = {}): Promise<AuditView[]> {
  const limit = Math.min(opts.limit ?? 100, 500);
  // Entries from one graph (a Work file, a graph shared with a partner) show only to that graph's members, so the
  // family log never reveals what someone does in their other graphs. Over-fetch, then filter.
  const [raw, mine] = await Promise.all([
    db.select().from(auditLog)
      .where(and(eq(auditLog.householdId, v.householdId), opts.userId ? eq(auditLog.userId, opts.userId) : undefined))
      .orderBy(desc(auditLog.at)).limit(limit * 4),
    db.select({ id: graphMembers.graphId }).from(graphMembers).where(eq(graphMembers.userId, v.id)),
  ]);
  const myGraphs = new Set(mine.map((m) => m.id));
  const rows = raw.filter((r) => auditVisibleTo(r, v.id, myGraphs)).slice(0, limit);
  const names = new Map((await db.select({ id: users.id, name: users.name }).from(users).where(eq(users.householdId, v.householdId))).map((u) => [u.id, u.name]));
  return rows.map((r) => ({
    id: r.id, at: r.at.toISOString(), action: r.action, actor: r.userId ? names.get(r.userId) ?? "Removed member" : null,
    targetType: r.targetType, targetId: r.targetId, meta: r.meta ?? {},
  }));
}
