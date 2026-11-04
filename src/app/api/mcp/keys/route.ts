import { accountRoute, audit, createKeyBody, jsonBody, McpHttpError, pickableGraphs } from "@/lib/mcp-server/account";
import { dbStore, listKeys, makeKey } from "@/lib/mcp-server";

/** GET /api/mcp/keys → { keys }. POST { name, graphId, scope } → { key, out }: the key itself, this once. */
export const dynamic = "force-dynamic";

export const GET = accountRoute(async (_req, v) => ({ keys: await listKeys(dbStore, v.id) }));

export const POST = accountRoute(async (req, v) => {
  const input = await jsonBody(req, createKeyBody);
  const graph = (await pickableGraphs(v)).find((g) => g.id === input.graphId);
  if (!graph) throw new McpHttpError(404, "You're not in that graph.", "notMember");
  const made = await makeKey(dbStore, v.id, input);
  await audit(v, "mcp.key.create", { type: "mcp_credential", id: made.out.id }, { name: made.out.name, scope: made.out.scope, graphId: made.out.graphId, graph: graph.name });
  return { key: made.key, out: made.out };
});
