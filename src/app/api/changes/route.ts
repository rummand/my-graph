import { z } from "zod";
import { listChangeSets } from "@/lib/changes";
import { query, route } from "@/lib/changes/http";
import { ORIGINS } from "@/lib/changes/store";

const q = z.object({
  status: z.enum(["draft", "delivered", "abandoned", "all"]).optional(),
  origin: z.enum(ORIGINS as [string, ...string[]]).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

/** GET /api/changes?status=&origin=&limit= → { changeSets } — proposals in the current graph the viewer may see. */
export const GET = route(async (req, v) => {
  const { status, origin, limit } = query(req, q);
  return { changeSets: await listChangeSets(v, { status: status ?? "draft", origin: origin as never, limit: limit ?? 50 }) };
});
