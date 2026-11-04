import { z } from "zod";
import { parseJson, route } from "@/lib/connectors/http";
import { startOAuth } from "@/lib/connectors/mcp/oauth-flow";

export const runtime = "nodejs";

const body = z.object({
  connectionId: z.uuid().optional(),
  connector: z.enum(["mcp", "record"]).optional(),
  label: z.string().max(120).optional(),
  config: z.object({
    serverUrl: z.string().trim().min(8).max(2000).optional(),
    visibility: z.enum(["private", "parents", "household"]).optional(),
  }).optional(),
  everyMinutes: z.number().int().min(15).max(10080).optional(),
}).refine((b) => !!b.connectionId || !!b.connector, "Say which connection to sign in for.");

/**
 * POST { connector, label?, config: { serverUrl, visibility }, everyMinutes? } (a new connection) or { connectionId }
 * (sign in again) → { connectionId, authorizeUrl }. The browser then goes to the server's own consent page.
 */
export const POST = route(async (req, v) => {
  const input = await parseJson(req, body);
  return await startOAuth(v, req, input);
});
