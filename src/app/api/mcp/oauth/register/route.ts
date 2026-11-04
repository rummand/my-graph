import { dbStore, ipOf, oauthOut, preflight, registerClient } from "@/lib/mcp-server";

/** POST /api/mcp/oauth/register: dynamic client registration (RFC 7591). */
export const dynamic = "force-dynamic";
export async function POST(req: Request) {
  const text = await req.text().catch(() => "");
  let body: unknown = null;
  if (text.length <= 20_000) { try { body = JSON.parse(text); } catch { body = null; } }
  return oauthOut(await registerClient(dbStore, body, ipOf(req)));
}
export const OPTIONS = preflight;
