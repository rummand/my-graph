import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { writeAudit } from "@/lib/auth/audit";
import { dbStore, oauthOut, preflight, revokeToken } from "@/lib/mcp-server";

/** POST /api/mcp/oauth/revoke: an app ends a token of its own (RFC 7009). Always 200 for tokens it doesn't own. */
export const dynamic = "force-dynamic";
export async function POST(req: Request) {
  const { answer, ended } = await revokeToken(dbStore, req);
  if (ended) {
    const [u] = await db.select({ householdId: users.householdId }).from(users).where(eq(users.id, ended.grant.userId));
    if (u) await writeAudit({ id: ended.grant.userId, householdId: u.householdId }, "mcp.revoke", { type: "mcp_credential", id: ended.grant.id }, { app: ended.client.name, why: "the app ended it", graphId: ended.grant.graphId });
  }
  return oauthOut(answer);
}
export const OPTIONS = preflight;
