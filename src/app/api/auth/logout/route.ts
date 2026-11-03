import { NextResponse, type NextRequest } from "next/server";
import { audit } from "@/lib/auth";
import { SESSION_COOKIE } from "@/lib/auth/constants";
import { isWellFormedToken } from "@/lib/auth/session";
import { clearSessionCookie } from "@/lib/auth/signin";
import { deleteSessionByToken } from "@/lib/auth/store";
import { findUserById } from "@/lib/auth/signin";

/** POST (form from the nav, or fetch): ends this session and goes to /login. */
export async function POST(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (isWellFormedToken(token)) {
    try {
      const s = await deleteSessionByToken(token);
      if (s) {
        const u = await findUserById(s.userId);
        if (u) await audit(u, "auth.logout", { type: "session", id: s.id });
      }
    } catch (err) {
      console.error("[auth] logout", err);
    }
  }
  // 303 so the browser follows with a GET.
  return clearSessionCookie(NextResponse.redirect(new URL("/login?reason=signed_out", req.url), 303));
}
