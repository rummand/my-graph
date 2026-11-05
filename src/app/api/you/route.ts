import { z } from "zod";
import { readYou, updateYouSettings } from "@/lib/you";
import { jsonBody, youRoute } from "@/lib/you/http";

/** GET /api/you → the signed-in person's own patterns (never anyone else's; there is no id to ask with). */
export const GET = youRoute(async (_req, v) => readYou(v));

const settings = z.object({ enabled: z.boolean().optional(), mood: z.boolean().optional(), combine: z.boolean().optional() }).strict();

/** PUT /api/you { enabled?, mood?, combine? } → change the person's own settings. enabled:false deletes every pattern. */
export const PUT = youRoute(async (req, v) => {
  await updateYouSettings(v, await jsonBody(req, settings));
  return readYou(v);
});
