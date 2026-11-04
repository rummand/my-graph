import { z } from "zod";
import { accountRoute, audit, McpHttpError } from "@/lib/mcp-server/account";
import { dbStore, revokeKey } from "@/lib/mcp-server";

/** DELETE /api/mcp/keys/:id: revoke one of my keys; it stops at once. */
export const dynamic = "force-dynamic";

export const DELETE = accountRoute(async (_req, v, ctx: { params: Promise<{ id: string }> }) => {
  const id = z.uuid().parse((await ctx.params).id);
  const k = await revokeKey(dbStore, v.id, id);
  if (!k) throw new McpHttpError(404, "That key doesn't exist, or it isn't yours.");
  await audit(v, "mcp.key.revoke", { type: "mcp_credential", id }, { name: k.name, graphId: k.graphId });
  return { ok: true };
});
