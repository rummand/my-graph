import { z } from "zod";
import { annotate } from "@/lib/mentions/annotate";
import { handle, jsonBody } from "@/lib/meta/http";

const input = z.object({
  text: z.string().max(4000),
  mentions: z.array(z.object({ label: z.string().trim().min(1).max(120), nodeId: z.uuid() })).max(20).optional(),
  sensitive: z.boolean().optional(),
});

/** POST /api/annotate { text, mentions? } — the whole text at once (older clients; the composer streams per sentence via /api/annotate/stream). Reads only; nothing is written. */
export const POST = handle(async (req, v) => annotate(v, await jsonBody(req, input)));
