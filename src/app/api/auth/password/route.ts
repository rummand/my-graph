import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { audit, getSession, requireUserApi } from "@/lib/auth";
import { AuthError, handle, parseBody } from "@/lib/auth/http";
import { hashPassword, passwordProblem, verifyPassword } from "@/lib/auth/passwords";
import { accountKey, accountLimiter, attemptKey, clientIp, loginLimiter } from "@/lib/auth/rate-limit";
import { changePasswordBody } from "@/lib/auth/schemas";
import { deleteOtherSessions } from "@/lib/auth/store";

/** POST { currentPassword?, newPassword, signOutOthers }: change (or first set) your password. */
export async function POST(req: Request) {
  return handle(async () => {
    const v = await requireUserApi();
    const body = await parseBody(req, changePasswordBody);
    const [u] = await db.select({ hash: users.passwordHash }).from(users).where(eq(users.id, v.id));
    if (u?.hash) {
      const key = attemptKey(clientIp(req.headers), `pw-change:${v.id}`);
      const acct = accountKey(`pw-change:${v.id}`);
      if (!accountLimiter.check(acct).allowed) throw new AuthError(429, "Too many attempts. Wait a few minutes and try again.");
      const limit = loginLimiter.check(key);
      if (!limit.allowed) throw new AuthError(429, "Too many attempts. Wait a few minutes and try again.");
      if (!body.currentPassword || !(await verifyPassword(body.currentPassword, u.hash))) {
        loginLimiter.fail(key);
        accountLimiter.fail(acct);
        await audit(v, "password.change_failed", { type: "user", id: v.id });
        throw new AuthError(400, "Your current password isn't right.", { fields: [{ key: "currentPassword", message: "Not right." }] });
      }
      loginLimiter.reset(key);
      accountLimiter.reset(acct);
    }
    const problem = passwordProblem(body.newPassword, { email: v.email, name: v.name });
    if (problem) throw new AuthError(400, problem, { fields: [{ key: "newPassword", message: problem }] });
    await db.update(users).set({ passwordHash: await hashPassword(body.newPassword) }).where(eq(users.id, v.id));
    let signedOut = 0;
    if (body.signOutOthers) {
      const s = await getSession();
      signedOut = await deleteOtherSessions(v.id, s.status === "active" ? s.sessionId : undefined);
    }
    await audit(v, u?.hash ? "password.change" : "password.set", { type: "user", id: v.id }, { signedOutSessions: signedOut });
    return Response.json({ ok: true, signedOut });
  });
}
