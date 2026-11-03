import type { NextRequest } from "next/server";
import { audit } from "@/lib/auth";
import { AuthError, errorJson, handle, parseBody } from "@/lib/auth/http";
import { attemptKey, clientIp, loginLimiter } from "@/lib/auth/rate-limit";
import { passkeyVerifyBody } from "@/lib/auth/schemas";
import { completeSignIn, findUserById } from "@/lib/auth/signin";
import { signInBlocked } from "@/lib/auth/store";
import { verifyAuthentication } from "@/lib/auth/webauthn";

/** POST { challengeId, response } → sets the session cookie. */
export async function POST(req: NextRequest) {
  return handle(async () => {
    const body = await parseBody(req, passkeyVerifyBody);
    const ip = clientIp(req.headers);
    const key = attemptKey(ip, "passkey");
    const limit = loginLimiter.check(key);
    if (!limit.allowed) {
      return errorJson(429, "Too many attempts. Wait a few minutes and try again.", undefined, { "Retry-After": String(limit.retryAfterSec) });
    }
    let found;
    try {
      found = await verifyAuthentication(body.challengeId, body.response, req.headers.get("origin"));
    } catch (e) {
      loginLimiter.fail(key);
      await audit(null, "auth.login_failed", undefined, { ip, method: "passkey" });
      throw e;
    }
    const user = await findUserById(found.userId);
    if (!user) throw new AuthError(401, "This passkey's account no longer exists.");
    const blocked = signInBlocked(user);
    if (blocked) {
      await audit(user, "auth.login_refused", { type: "user", id: user.id }, { ip, reason: "guest_access_ended", method: "passkey" });
      return errorJson(403, blocked);
    }
    loginLimiter.reset(key);
    const res = await completeSignIn(req, user, "passkey");
    await audit(user, "auth.login", { type: "user", id: user.id }, { ip, method: "passkey", passkeyId: found.passkeyId });
    return res;
  });
}
