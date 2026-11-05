/**
 * Request guard for every request (runs on the edge, before any page or handler).
 *
 * CSRF: every state-changing request to /api must come from this site. Browsers send `Origin` on cross-site POST /
 * PATCH / PUT / DELETE (and on same-origin ones from fetch); a request whose Origin isn't ours, or that the browser
 * labels cross-site, is refused before any handler runs. Requests without either header (curl, server-to-server)
 * carry no ambient browser cookies' intent and fall through to the handler's own session check.
 *
 * Auth: app pages without a session cookie go to /login (presence check only — `requireUser()` does the real check
 * against the database). Middleware also tells `requireUser()` whether this is an API request (answer 401 JSON) or a
 * page (redirect), and which path to come back to after signing in. Signed-in page views refresh the cookie's
 * lifetime so an active session keeps sliding forward.
 */
import { NextResponse, type NextRequest } from "next/server";
import { isAllowedOrigin } from "@/lib/security/origin";
import { API_HEADER, PATH_HEADER, SESSION_COOKIE, isPublicPath, sessionCookieOptions } from "@/lib/auth/constants";

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * MCP endpoints that authenticate with a bearer token or client credentials and never read the session cookie, so a
 * cross-site request carries no ambient authority. Browser-based MCP clients call these from their own origin. The
 * consent (authorize), keys and apps routes use the session and keep the origin check.
 */
const BEARER_ONLY = new Set(["/api/mcp", "/api/mcp/oauth/register", "/api/mcp/oauth/token", "/api/mcp/oauth/revoke"]);

/**
 * Server-to-server webhooks that authenticate by a signature over the raw body (never a session cookie), so they skip
 * the origin check. Stripe: /api/webhooks/stripe, verified with STRIPE_WEBHOOK_SECRET in the handler.
 */
const SIGNED_WEBHOOKS = new Set(["/api/webhooks/stripe"]);

export function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  const isApi = pathname.startsWith("/api/") || pathname === "/api";

  if (isApi && !SAFE.has(req.method) && !BEARER_ONLY.has(pathname) && !SIGNED_WEBHOOKS.has(pathname)) {
    const ok = isAllowedOrigin({
      origin: req.headers.get("origin"),
      secFetchSite: req.headers.get("sec-fetch-site"),
      host: req.headers.get("host"),
      forwardedHost: req.headers.get("x-forwarded-host"),
      appUrl: process.env.APP_URL,
    });
    if (!ok) return NextResponse.json({ error: "This request came from another site and was blocked." }, { status: 403 });
  }

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (!isApi && !token && !isPublicPath(pathname)) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    if (pathname !== "/") url.searchParams.set("next", pathname + search);
    return NextResponse.redirect(url);
  }

  // Headers for requireUser(); always overwritten so a client can't supply its own.
  const headers = new Headers(req.headers);
  headers.set(PATH_HEADER, pathname + search);
  if (isApi) headers.set(API_HEADER, "1");
  else headers.delete(API_HEADER);
  const res = NextResponse.next({ request: { headers } });

  if (token && !isApi && req.method === "GET" && !isPublicPath(pathname)) {
    res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
  }
  return res;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg|apple-icon.png|manifest.webmanifest|icons/).*)"],
};
