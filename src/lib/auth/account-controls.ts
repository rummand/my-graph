/**
 * Admin controls on an account (server-only, no Next imports): lock / unlock, sign out everywhere, one-time password
 * reset links (24 hours, single use, only sha256(token) stored) and temporary passwords that must be changed at the
 * next sign-in. Used by the platform admin console (src/app/api/admin) and the reset page (/login/reset/[token]).
 */
import { randomInt } from "node:crypto";
import { and, eq, gt, isNull, lte } from "drizzle-orm";
import { db } from "@/db";
import { accountControls, passwordResets, sessions, users } from "@/db/schema";
import { hashPassword } from "./passwords";
import { hashToken, newToken } from "./session";

export const RESET_TTL_MS = 24 * 60 * 60 * 1000;
export const LOCKED_MESSAGE = "This account is locked. Contact My Graph support to unlock it.";

export type ResetTokenState = "ok" | "missing" | "used" | "expired";

/** Whether a stored reset link can still be used (pure). */
export function resetTokenState(row: { expiresAt: Date; usedAt: Date | null } | null | undefined, now = new Date()): ResetTokenState {
  if (!row) return "missing";
  if (row.usedAt) return "used";
  if (row.expiresAt.getTime() <= now.getTime()) return "expired";
  return "ok";
}

/** A locked account can't sign in (pure). */
export function lockedProblem(c: { lockedAt: Date | null } | null | undefined): string | null {
  return c?.lockedAt ? LOCKED_MESSAGE : null;
}

/** A temporary password is still in use when the stored password hash is the one the admin set (pure). */
export function mustChangePassword(passwordHash: string | null | undefined, tempPasswordHash: string | null | undefined): boolean {
  return !!tempPasswordHash && !!passwordHash && passwordHash === tempPasswordHash;
}

/** A readable temporary password: three groups of four from an alphabet without look-alikes (≈ 70 bits). */
export function generateTemporaryPassword(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyzACDEFGHJKLMNPQRTUVWXY34679";
  const group = () => Array.from({ length: 4 }, () => alphabet[randomInt(alphabet.length)]).join("");
  return `${group()}-${group()}-${group()}`;
}

export async function accountControlsFor(userId: string) {
  const [c] = await db.select().from(accountControls).where(eq(accountControls.userId, userId)).limit(1);
  return c ?? null;
}

export async function isLocked(userId: string): Promise<boolean> {
  return !!lockedProblem(await accountControlsFor(userId));
}

/** End every session the person has, on every device. */
export async function signOutEverywhere(userId: string): Promise<number> {
  const rows = await db.delete(sessions).where(eq(sessions.userId, userId)).returning({ id: sessions.id });
  return rows.length;
}

/** Lock (and sign out everywhere) or unlock. */
export async function setLocked(userId: string, locked: boolean, by: string, reason?: string | null): Promise<{ signedOut: number }> {
  const now = new Date();
  const values = locked
    ? { lockedAt: now, lockedBy: by, lockReason: reason?.trim() || null, updatedAt: now }
    : { lockedAt: null, lockedBy: null, lockReason: null, updatedAt: now };
  await db.insert(accountControls).values({ userId, ...values })
    .onConflictDoUpdate({ target: accountControls.userId, set: values });
  return { signedOut: locked ? await signOutEverywhere(userId) : 0 };
}

/** Make a reset link token. Earlier unused links for the person stop working. */
export async function issueResetToken(userId: string, by: string, now = new Date()): Promise<{ token: string; expiresAt: Date }> {
  await db.delete(passwordResets).where(and(eq(passwordResets.userId, userId), isNull(passwordResets.usedAt)));
  await db.delete(passwordResets).where(lte(passwordResets.expiresAt, new Date(now.getTime() - 7 * RESET_TTL_MS)));
  const token = newToken();
  const expiresAt = new Date(now.getTime() + RESET_TTL_MS);
  await db.insert(passwordResets).values({ userId, tokenHash: hashToken(token), createdBy: by, expiresAt });
  return { token, expiresAt };
}

/** Look at a reset link without using it (for the reset page). */
export async function peekResetToken(token: string, now = new Date()): Promise<{ state: ResetTokenState; user: { id: string; name: string; email: string; householdId: string } | null }> {
  const [row] = await db.select({
    expiresAt: passwordResets.expiresAt, usedAt: passwordResets.usedAt,
    id: users.id, name: users.name, email: users.email, householdId: users.householdId,
  }).from(passwordResets).innerJoin(users, eq(users.id, passwordResets.userId))
    .where(eq(passwordResets.tokenHash, hashToken(token))).limit(1);
  const state = resetTokenState(row, now);
  return { state, user: state === "ok" && row ? { id: row.id, name: row.name, email: row.email, householdId: row.householdId } : null };
}

/**
 * Use a reset link: atomically claims it (only one request can), sets the new password, clears any temporary
 * password and signs the person out everywhere. Returns the user, or the reason it can't be used.
 */
export async function redeemResetToken(token: string, newPassword: string, now = new Date()):
  Promise<{ ok: true; userId: string; householdId: string } | { ok: false; state: ResetTokenState }> {
  const tokenHash = hashToken(token);
  const passwordHash = await hashPassword(newPassword);
  const [claimed] = await db.update(passwordResets).set({ usedAt: now })
    .where(and(eq(passwordResets.tokenHash, tokenHash), isNull(passwordResets.usedAt), gt(passwordResets.expiresAt, now)))
    .returning({ userId: passwordResets.userId });
  if (!claimed) {
    const [row] = await db.select({ expiresAt: passwordResets.expiresAt, usedAt: passwordResets.usedAt }).from(passwordResets)
      .where(eq(passwordResets.tokenHash, tokenHash)).limit(1);
    const state = resetTokenState(row, now);
    return { ok: false, state: state === "ok" ? "used" : state };
  }
  const [u] = await db.update(users).set({ passwordHash }).where(eq(users.id, claimed.userId)).returning({ householdId: users.householdId });
  await db.update(accountControls).set({ tempPasswordHash: null, updatedAt: now }).where(eq(accountControls.userId, claimed.userId));
  await signOutEverywhere(claimed.userId);
  return { ok: true, userId: claimed.userId, householdId: u.householdId };
}

/** Set a temporary password the person must change at their next sign-in. Signs them out everywhere. */
export async function setTemporaryPassword(userId: string): Promise<{ password: string; signedOut: number }> {
  const password = generateTemporaryPassword();
  const hash = await hashPassword(password);
  const now = new Date();
  await db.update(users).set({ passwordHash: hash }).where(eq(users.id, userId));
  await db.insert(accountControls).values({ userId, tempPasswordHash: hash, updatedAt: now })
    .onConflictDoUpdate({ target: accountControls.userId, set: { tempPasswordHash: hash, updatedAt: now } });
  await db.delete(passwordResets).where(and(eq(passwordResets.userId, userId), isNull(passwordResets.usedAt)));
  return { password, signedOut: await signOutEverywhere(userId) };
}
