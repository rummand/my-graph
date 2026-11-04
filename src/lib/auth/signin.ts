/** Turning a verified identity into a session cookie (route handlers only). */
import { NextResponse, type NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { LOCKED_MESSAGE, isLocked } from "./account-controls";
import { writeAudit } from "./audit";
import { DEVICE_COOKIE, SESSION_COOKIE } from "./constants";
import { AuthError } from "./http";
import { clientIp } from "./rate-limit";
import { deviceCookieOptions, isWellFormedToken, newToken, sessionCookieOptions } from "./session";
import { createSession, pruneExpired } from "./store";

export type UserRow = typeof users.$inferSelect;

export async function findUserByLogin(login: string): Promise<UserRow | null> {
  const [u] = await db.select().from(users).where(eq(users.email, login.trim().toLowerCase())).limit(1);
  return u ?? null;
}

export async function findUserById(id: string): Promise<UserRow | null> {
  const [u] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return u ?? null;
}

/** Create a fresh session (rotating any previous one), set the cookies and answer with where to go next. */
export async function completeSignIn(req: NextRequest, user: UserRow, method: "password" | "passkey" | "setup"): Promise<NextResponse> {
  // A locked account never gets a session, whichever way it proved who it is (password, passkey).
  if (await isLocked(user.id)) {
    await writeAudit(user, "auth.login_refused", { type: "user", id: user.id }, { ip: clientIp(req.headers), method, reason: "account_locked" });
    throw new AuthError(403, LOCKED_MESSAGE);
  }
  const previous = req.cookies.get(SESSION_COOKIE)?.value;
  const existingDevice = req.cookies.get(DEVICE_COOKIE)?.value;
  const deviceId = isWellFormedToken(existingDevice) ? existingDevice : newToken();
  pruneExpired().catch(() => {});
  const s = await createSession(user, {
    userAgent: req.headers.get("user-agent"), deviceId, method, ip: clientIp(req.headers),
    previousToken: isWellFormedToken(previous) ? previous : null,
  });
  const res = NextResponse.json({ ok: true, pending: !s.approved });
  res.cookies.set(SESSION_COOKIE, s.token, sessionCookieOptions());
  if (deviceId !== existingDevice) res.cookies.set(DEVICE_COOKIE, deviceId, deviceCookieOptions());
  return res;
}

export function clearSessionCookie(res: NextResponse): NextResponse {
  res.cookies.set(SESSION_COOKIE, "", { ...sessionCookieOptions(), maxAge: 0 });
  return res;
}
