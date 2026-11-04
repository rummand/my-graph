import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { ConnectionError } from "@/lib/connectors";
import { appOrigin, connectionIdOfState, finishOAuth } from "@/lib/connectors/mcp/oauth-flow";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET ?code&state&iss (or ?error) — where an MCP server sends the person back after its consent page. Finishes the
 * sign-in and goes to the connection's page. Only ever redirects to a path on My Graph (no open redirect); a
 * problem is said on the connection's page (or on Connections) as ?signin=<message>.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const p = url.searchParams;
  const base = appOrigin(req);
  const to = (path: string, msg?: string) => NextResponse.redirect(new URL(`${path}${msg ? `?signin=${encodeURIComponent(msg.slice(0, 300))}` : "?signin=ok"}`, base), 303);
  const s = await getSession();
  if (s.status !== "active") return NextResponse.redirect(new URL(`/login?next=${encodeURIComponent(`/api/connections/oauth/callback${url.search}`)}`, base), 303);
  const id = connectionIdOfState(p.get("state"));
  try {
    const done = await finishOAuth(s.viewer, { code: p.get("code"), state: p.get("state"), iss: p.get("iss"), error: p.get("error"), errorDescription: p.get("error_description") });
    return to(`/connections/${done}`);
  } catch (e) {
    const msg = e instanceof ConnectionError ? e.message : "The sign-in didn't finish. Try again.";
    if (!(e instanceof ConnectionError)) console.error("[connections oauth]", e instanceof Error ? e.message : e);
    return to(id && !(e instanceof ConnectionError && e.status === 404) ? `/connections/${id}` : "/connections", msg);
  }
}
