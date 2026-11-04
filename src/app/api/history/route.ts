import { z } from "zod";
import { historyOf } from "@/lib/changes";
import { isoDate, query, route } from "@/lib/changes/http";

const q = z.object({
  subjectId: z.uuid().optional(),
  since: isoDate.optional(),
  until: isoDate.optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

/** GET /api/history?subjectId=&since=&until=&limit= → { events } — newest first, only what the viewer may see. */
export const GET = route(async (req, v) => {
  const { subjectId, since, until, limit } = query(req, q);
  return { events: await historyOf(v, { subjectId, since, until, limit }) };
});
