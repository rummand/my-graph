/**
 * /api/connections/mac (signed in): my Mac connection in this graph.
 *   GET    status: pairing, the paired helper, my choices, the conversations and folders the helper reported, last send.
 *   POST   { visibility? } → 201 { code, expiresAt, connectionId }: a one-time pairing code for the helper.
 *   PATCH  { visibility?, messages?, notes?, resend?, signOutHelper? }: what the helper may send.
 */
import { z } from "zod";
import { parseJson, route } from "@/lib/connectors/http";
import { CATALOG_MAX_CHATS, CATALOG_MAX_FOLDERS, SINCE } from "@/lib/connectors/mac/config";
import { macStatus, startMacPairing, updateMacChoices } from "@/lib/connectors/mac/server";

const visibility = z.enum(["private", "parents", "household"]);

export const GET = route(async (_req, v) => macStatus(v));

const startBody = z.object({ visibility: visibility.optional() }).strict();

export const POST = route(async (req, v) => {
  const body = await parseJson(req, startBody);
  return Response.json(await startMacPairing(v, body), { status: 201, headers: { "cache-control": "no-store" } });
});

const patchBody = z.object({
  visibility: visibility.optional(),
  messages: z.object({
    enabled: z.boolean().optional(),
    scope: z.enum(["chosen", "known"]).optional(),
    chats: z.array(z.string().min(1).max(300)).max(CATALOG_MAX_CHATS).optional(),
    since: z.enum(SINCE).optional(),
  }).strict().optional(),
  notes: z.object({
    enabled: z.boolean().optional(),
    folders: z.array(z.string().min(1).max(300)).max(CATALOG_MAX_FOLDERS).nullable().optional(),
  }).strict().optional(),
  resend: z.enum(["messages", "notes", "both"]).optional(),
  signOutHelper: z.literal(true).optional(),
}).strict().refine((b) => Object.keys(b).length > 0, "Nothing to change.");

export const PATCH = route(async (req, v) => updateMacChoices(v, await parseJson(req, patchBody)));
