import { z } from "zod";
import { parseJson, route } from "@/lib/connectors/http";
import { startProviderOAuth } from "@/lib/connectors/oauth/flow";

export const runtime = "nodejs";

const body = z.object({
  connectionId: z.uuid().optional(),
  connector: z.enum(["gmail", "google_calendar", "google_drive", "microsoft", "dropbox"]).optional(),
  label: z.string().max(120).optional(),
  autoLabel: z.boolean().optional(),
  config: z.record(z.string().max(40), z.unknown()).optional(),
  everyMinutes: z.number().int().min(15).max(10080).optional(),
}).refine((b) => !!b.connectionId || !!b.connector, "Say which connection to sign in for.");

/**
 * POST { connector, label?, config?, everyMinutes? } (a new Google, Microsoft or Dropbox connection) or
 * { connectionId } (sign in again) → { connectionId, authorizeUrl }. The browser then goes to the provider's consent page.
 * Same-origin is enforced by middleware for every state-changing /api request.
 */
export const POST = route(async (req, v) => {
  const input = await parseJson(req, body);
  return await startProviderOAuth(v, req, input);
});
