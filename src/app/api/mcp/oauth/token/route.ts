import { writeAudit } from "@/lib/auth/audit";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { dbStore, oauthOut, originOf, preflight, token, type TokenEvent } from "@/lib/mcp-server";

/** POST /api/mcp/oauth/token: a code (with its PKCE verifier) or a refresh token for new tokens. */
export const dynamic = "force-dynamic";
export async function POST(req: Request) {
  const events: TokenEvent = {};
  const answer = await token(dbStore, req, originOf(req), events);
  const r = events.reused;
  if (r) {
    const [u] = await db.select({ householdId: users.householdId }).from(users).where(eq(users.id, r.userId));
    if (u) await writeAudit({ id: r.userId, householdId: u.householdId }, "mcp.revoke", { type: "mcp_credential", id: r.grantId }, { app: r.client, why: `a ${r.what} was used twice`, graphId: r.graphId });
  }
  return oauthOut(answer);
}
export const OPTIONS = preflight;
