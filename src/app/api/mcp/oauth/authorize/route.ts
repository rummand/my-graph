import { NextResponse } from "next/server";
import { audit, requireUserApi } from "@/lib/auth";
import { mayConnectApps } from "@/lib/mcp-server/account";
import { approve, CONSENT_PATH, consentOf, dbStore, originOf, PARAMS } from "@/lib/mcp-server";

/**
 * POST /api/mcp/oauth/authorize: the consent page's form (the person's session; middleware refuses it from another
 * origin). `decision=allow|deny`, `access` (read | propose), `graph` (one graph id), and the app's request in hidden
 * fields. → 303 to the app's redirect with `code`, `state` and `iss`, or `error=access_denied`; a problem the person
 * must see goes back to the consent page with `problem=`.
 */
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const origin = originOf(req);
  let form: FormData;
  try { form = await req.formData(); } catch { return NextResponse.json({ error: "Send the consent form." }, { status: 400 }); }
  const { p, choice } = consentOf(form);
  // The page sends the form with fetch and follows the answer itself: the CSP's form-action 'self' would stop a browser
  // from following a form's redirect to the app's own address. Without JavaScript it is a plain form and a 303.
  const wantsJson = (req.headers.get("accept") ?? "").includes("application/json");
  const backToPage = (problem: string) => {
    if (wantsJson) return NextResponse.json({ problem }, { status: 400 });
    const u = new URL(CONSENT_PATH, origin);
    for (const k of PARAMS) if (p[k]) u.searchParams.set(k, p[k]!);
    u.searchParams.set("problem", problem);
    return NextResponse.redirect(u, 303);
  };
  let v;
  try { v = await requireUserApi(); } catch { return backToPage("signedOut"); }
  if (!mayConnectApps(v)) return backToPage("notAllowed");
  const r = await approve(dbStore, v.id, origin, p, choice);
  if ("show" in r) return backToPage(r.show);
  if (r.allowed) {
    await audit(v, "mcp.allow", { type: "mcp_client", id: r.allowed.client.id }, { app: r.allowed.client.name, scope: r.allowed.scope, graphId: r.allowed.graphId, graph: r.allowed.graphName });
  } else if (!choice.allow) {
    await audit(v, "mcp.deny", { type: "mcp_client", id: p.client_id ?? "" }, {});
  }
  return wantsJson ? NextResponse.json({ redirect: r.redirect }) : NextResponse.redirect(r.redirect, 303);
}
