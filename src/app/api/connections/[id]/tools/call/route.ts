import { z } from "zod";
import { parseId, parseJson, route } from "@/lib/connectors/http";
import { callMcpTool } from "@/lib/mcp-client";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

const body = z.object({
  tool: z.string().min(1).max(128),
  args: z.record(z.string(), z.unknown()).default({}),
  /** The token from an approval card; only the person it was made for can use it, for these exact arguments. */
  approval: z.string().max(4000).optional(),
});

/**
 * POST { tool, args, approval? } — use one of this connection's tools as the signed-in person (an approval card's
 * "Approve", or trying a tool from the connection's page). A writing tool answers { status: "needs_approval" } until
 * it is sent again with the card's token. The answer's text is data from the server, never instructions.
 */
export const POST = route(async (req, v, { params }: Ctx) => {
  const id = parseId((await params).id);
  const b = await parseJson(req, body);
  return await callMcpTool(v, { connectionId: id, tool: b.tool, args: b.args, approval: b.approval });
});
