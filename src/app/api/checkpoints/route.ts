import { z } from "zod";
import { body, HttpError, isoDate, route } from "@/lib/changes/http";
import { createCheckpoint, listCheckpoints } from "@/lib/history/read";

const schema = z.object({ label: z.string().trim().min(1, "Give the moment a name").max(120), at: isoDate.optional() }).strict();

/** GET /api/checkpoints → { checkpoints } (named moments in the current graph). */
export const GET = route(async (_req, v) => ({ checkpoints: await listCheckpoints(v) }));

/** POST /api/checkpoints { label, at? } → { checkpoint } — mark a moment to come back to. */
export const POST = route(async (req, v) => {
  const input = await body(req, schema);
  const checkpoint = await createCheckpoint(v, input);
  if (!checkpoint) throw new HttpError(403, "You can look at this graph but not mark moments in it.");
  return { checkpoint };
});
