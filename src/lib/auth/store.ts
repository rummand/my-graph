/** Session and device storage (server-only; no Next imports so it can be unit-tested and scripted). */
import { and, desc, eq, gt, inArray, lte, ne } from "drizzle-orm";
import { db } from "@/db";
import { accountControls, auditLog, authChallenges, sessions, users } from "@/db/schema";
import { guestActive } from "@/lib/gbrain/access";
import { lockedProblem, mustChangePassword } from "./account-controls";
import { writeAudit } from "./audit";
import { hashToken, needsDeviceApproval, newToken, sessionExpiry, shouldTouch } from "./session";

export type Role = "owner" | "parent" | "child" | "guest";

export type ViewerRow = {
  id: string; householdId: string; name: string; email: string; role: Role; personNodeId: string | null;
};

export type SessionState =
  | { status: "none"; reason?: "expired" | "access_ended" | "locked" }
  | { status: "pending"; sessionId: string; viewer: ViewerRow }
  | { status: "active"; sessionId: string; viewer: ViewerRow; mustChangePassword?: boolean };

type UserRow = typeof users.$inferSelect;

export function toViewer(u: Pick<UserRow, "id" | "householdId" | "name" | "email" | "role" | "personNodeId">): ViewerRow {
  return { id: u.id, householdId: u.householdId, name: u.name, email: u.email, role: u.role, personNodeId: u.personNodeId };
}

/** Whether this user may sign in at all right now (guests: access not ended). */
export function signInBlocked(u: Pick<UserRow, "role" | "accessExpiresAt">, now = new Date()): string | null {
  if (u.role === "guest" && !guestActive(u.accessExpiresAt, now)) return "Your guest access has ended. Ask the family to extend it.";
  return null;
}

/** Look up the session for a raw cookie token. Expired sessions are deleted; live ones slide forward. */
export async function loadSession(token: string, now = new Date()): Promise<SessionState> {
  const tokenHash = hashToken(token);
  const [row] = await db.select({
    sid: sessions.id, approved: sessions.approved, expiresAt: sessions.expiresAt, lastSeenAt: sessions.lastSeenAt,
    id: users.id, householdId: users.householdId, name: users.name, email: users.email, role: users.role,
    personNodeId: users.personNodeId, accessExpiresAt: users.accessExpiresAt, passwordHash: users.passwordHash,
    lockedAt: accountControls.lockedAt, tempPasswordHash: accountControls.tempPasswordHash,
  }).from(sessions).innerJoin(users, eq(users.id, sessions.userId))
    .leftJoin(accountControls, eq(accountControls.userId, sessions.userId))
    .where(eq(sessions.tokenHash, tokenHash)).limit(1);
  if (!row) return { status: "none" };
  if (row.expiresAt.getTime() <= now.getTime()) {
    await db.delete(sessions).where(eq(sessions.id, row.sid));
    return { status: "none", reason: "expired" };
  }
  if (signInBlocked(row, now)) {
    await db.delete(sessions).where(eq(sessions.userId, row.id));
    await writeAudit(row, "session.ended_access_expired", { type: "user", id: row.id });
    return { status: "none", reason: "access_ended" };
  }
  if (lockedProblem(row)) {
    // Locking ends every session; this catches one that slipped through.
    await db.delete(sessions).where(eq(sessions.userId, row.id));
    return { status: "none", reason: "locked" };
  }
  if (shouldTouch(row.lastSeenAt, now)) {
    await db.update(sessions).set({ lastSeenAt: now, expiresAt: sessionExpiry(now) }).where(eq(sessions.id, row.sid));
  }
  const viewer = toViewer(row);
  return row.approved
    ? { status: "active", sessionId: row.sid, viewer, mustChangePassword: mustChangePassword(row.passwordHash, row.tempPasswordHash) }
    : { status: "pending", sessionId: row.sid, viewer };
}

/** A device a parent has approved for this user (latest decision wins). */
export async function deviceApproved(userId: string, deviceHash: string): Promise<boolean> {
  const [last] = await db.select({ action: auditLog.action }).from(auditLog)
    .where(and(eq(auditLog.targetType, "device"), eq(auditLog.targetId, `${userId}:${deviceHash}`),
      inArray(auditLog.action, ["device.approve", "device.revoke"])))
    .orderBy(desc(auditLog.at)).limit(1);
  return last?.action === "device.approve";
}

/** The device a pending session came from (recorded when the session was created). */
export async function deviceOfSession(sessionId: string): Promise<string | null> {
  const [row] = await db.select({ meta: auditLog.meta }).from(auditLog)
    .where(and(eq(auditLog.action, "session.create"), eq(auditLog.targetType, "session"), eq(auditLog.targetId, sessionId)))
    .limit(1);
  const d = row?.meta?.deviceHash;
  return typeof d === "string" ? d : null;
}

/**
 * Create a session for a user who just proved who they are. `previousToken` (the cookie the browser already had) is
 * revoked so every sign-in gets a fresh token. Children and guests on a device no parent has approved get a
 * pending session.
 */
export async function createSession(
  u: Pick<UserRow, "id" | "householdId" | "role">,
  opts: { userAgent: string | null; deviceId: string; previousToken?: string | null; method: "password" | "passkey" | "setup"; ip?: string },
): Promise<{ token: string; sessionId: string; approved: boolean }> {
  if (opts.previousToken) await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(opts.previousToken)));
  const deviceHash = hashToken(`device:${opts.deviceId}`);
  const approved = !needsDeviceApproval(u.role) || (await deviceApproved(u.id, deviceHash));
  const token = newToken();
  const [row] = await db.insert(sessions).values({
    userId: u.id, tokenHash: hashToken(token), userAgent: opts.userAgent?.slice(0, 400) ?? null, approved,
    expiresAt: sessionExpiry(),
  }).returning({ id: sessions.id });
  await writeAudit({ id: u.id, householdId: u.householdId }, "session.create", { type: "session", id: row.id },
    { method: opts.method, approved, deviceHash, ip: opts.ip ?? null });
  return { token, sessionId: row.id, approved };
}

export async function deleteSessionByToken(token: string): Promise<{ id: string; userId: string } | null> {
  const [row] = await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token))).returning({ id: sessions.id, userId: sessions.userId });
  return row ?? null;
}

/** Sign a user out everywhere except (optionally) one session. */
export async function deleteOtherSessions(userId: string, keepSessionId?: string): Promise<number> {
  const rows = await db.delete(sessions)
    .where(and(eq(sessions.userId, userId), keepSessionId ? ne(sessions.id, keepSessionId) : undefined))
    .returning({ id: sessions.id });
  return rows.length;
}

export async function listSessions(userIds: string[], now = new Date()) {
  if (!userIds.length) return [];
  return db.select({
    id: sessions.id, userId: sessions.userId, userAgent: sessions.userAgent, approved: sessions.approved,
    createdAt: sessions.createdAt, lastSeenAt: sessions.lastSeenAt, expiresAt: sessions.expiresAt,
  }).from(sessions).where(and(inArray(sessions.userId, userIds), gt(sessions.expiresAt, now)))
    .orderBy(desc(sessions.lastSeenAt));
}

/** Housekeeping: drop expired sessions and WebAuthn challenges. Cheap; called on sign-in. */
export async function pruneExpired(now = new Date()): Promise<void> {
  await db.delete(sessions).where(lte(sessions.expiresAt, now));
  await db.delete(authChallenges).where(lte(authChallenges.expiresAt, now));
}
