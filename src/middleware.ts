/**
 * Request guard for the API (auth workstream may extend this with session handling).
 *
 * CSRF: every state-changing request to /api must come from this site. Browsers send `Origin` on cross-site POST /
 * PATCH / PUT / DELETE (and on same-origin ones from fetch); a request whose Origin isn't ours, or that the browser
 * labels cross-site, is refused before any handler runs. Requests without either header (curl, server-to-server)
 * carry no ambient browser cookies' intent and fall through to the handler's own session check.
 */
import { NextResponse, type NextRequest } from "next/server";
import { isAllowedOrigin } from "@/lib/security/origin";

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

export function middleware(req: NextRequest) {
  if (SAFE.has(req.method)) return NextResponse.next();
  const ok = isAllowedOrigin({
    origin: req.headers.get("origin"),
    secFetchSite: req.headers.get("sec-fetch-site"),
    host: req.headers.get("host"),
    forwardedHost: req.headers.get("x-forwarded-host"),
    appUrl: process.env.APP_URL,
  });
  if (!ok) return NextResponse.json({ error: "This request came from another site and was blocked." }, { status: 403 });
  return NextResponse.next();
}

export const config = { matcher: ["/api/:path*"] };
