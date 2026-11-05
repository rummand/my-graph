import { z } from "zod";
import { handle, jsonBody } from "@/lib/meta/http";
import { readFacts } from "@/lib/mentions/live/server";

const input = z.object({
  text: z.string().trim().min(1).max(4000),
  entities: z.array(z.object({
    ref: z.string().max(60), label: z.string().trim().min(1).max(120), type: z.string().max(30), nodeId: z.uuid().nullable(),
  })).max(40),
  sensitive: z.boolean().optional(),
});

/**
 * POST /api/annotate/facts { text, entities, sensitive? } — the composer's whole-text pass for facts between things it
 * already shows (sent only after a pause, when new things appeared). Reads only.
 */
export const POST = handle(async (req, v) => readFacts(v, await jsonBody(req, input)));
