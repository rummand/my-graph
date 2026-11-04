import { z } from "zod";
import { accountRoute, audit, McpHttpError } from "@/lib/mcp-server/account";
import { dbStore, disconnectApp } from "@/lib/mcp-server";

/** DELETE /api/mcp/apps/:id: disconnect an app; every token of it stops at once. */
export const dynamic = "force-dynamic";

export const DELETE = accountRoute(async (_req, v, ctx: { params: Promise<{ id: string }> }) => {
  const id = z.string().regex(/^mgg_[A-Za-z0-9_-]{10,40}$/, "Not a connection id").parse((await ctx.params).id);
  const ended = await disconnectApp(dbStore, v.id, id);
  if (!ended) throw new McpHttpError(404, "That app isn't connected, or the connection isn't yours.");
  await audit(v, "mcp.revoke", { type: "mcp_credential", id }, { app: ended.app, why: "you disconnected it", graphId: ended.grant.graphId });
  return { ok: true };
});
