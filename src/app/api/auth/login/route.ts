import type { NextRequest } from "next/server";
import { audit } from "@/lib/auth";
import { errorJson, handle, parseBody } from "@/lib/auth/http";
import { verifyPassword } from "@/lib/auth/passwords";
import { accountKey, accountLimiter, attemptKey, clientIp, loginLimiter } from "@/lib/auth/rate-limit";
import { loginBody } from "@/lib/auth/schemas";
import { completeSignIn, findUserByLogin } from "@/lib/auth/signin";
import { signInBlocked } from "@/lib/auth/store";

const WRONG = "That email or username and password don't match. Check them and try again.";

/** POST { email, password } → sets the session cookie. */
export async function POST(req: NextRequest) {
  return handle(async () => {
    const body = await parseBody(req, loginBody);
    const ip = clientIp(req.headers);
    const key = attemptKey(ip, body.email);
    const acct = accountKey(body.email);
    const ipLimit = loginLimiter.check(key);
    const acctLimit = accountLimiter.check(acct);
    const limit = !ipLimit.allowed ? ipLimit : acctLimit;
    const user = await findUserByLogin(body.email);
    if (!limit.allowed) {
      if (user) await audit(user, "auth.rate_limited", { type: "user", id: user.id }, { ip });
      const minutes = Math.ceil(limit.retryAfterSec / 60);
      return errorJson(429, `Too many attempts. Wait ${minutes} minute${minutes === 1 ? "" : "s"} and try again.`, undefined,
        { "Retry-After": String(limit.retryAfterSec) });
    }
    const ok = await verifyPassword(body.password, user?.passwordHash);
    if (!user || !ok) {
      loginLimiter.fail(key);
      accountLimiter.fail(acct);
      if (user) await audit(user, "auth.login_failed", { type: "user", id: user.id }, { ip, method: "password" });
      else await audit(null, "auth.login_failed", undefined, { ip, method: "password", unknownLogin: true });
      return errorJson(401, WRONG);
    }
    const blocked = signInBlocked(user);
    if (blocked) {
      await audit(user, "auth.login_refused", { type: "user", id: user.id }, { ip, reason: "guest_access_ended" });
      return errorJson(403, blocked);
    }
    loginLimiter.reset(key);
    accountLimiter.reset(acct);
    const res = await completeSignIn(req, user, "password");
    await audit(user, "auth.login", { type: "user", id: user.id }, { ip, method: "password" });
    return res;
  });
}
