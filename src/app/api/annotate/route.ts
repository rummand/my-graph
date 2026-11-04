import { z } from "zod";
import { annotate } from "@/lib/mentions/annotate";
import { handle, jsonBody } from "@/lib/meta/http";

const input = z.object({
  text: z.string().max(4000),
  mentions: z.array(z.object({ label: z.string().trim().min(1).max(120), nodeId: z.uuid() })).max(20).optional(),
});

/** POST /api/annotate { text, mentions? } — live highlights for the composer. Reads only; nothing is written. */
export const POST = handle(async (req, v) => annotate(v, await jsonBody(req, input)));
