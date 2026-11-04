import { z } from "zod";
import { getChangeSet } from "@/lib/changes";
import { HttpError, idParams, query, route } from "@/lib/changes/http";
import { reviewContext } from "@/lib/changes/store";

type Ctx = { params: Promise<{ id: string }> };
const q = z.object({ context: z.enum(["1", "true"]).optional() });

/**
 * GET /api/changes/:id[?context=1] → { changeSet, context? } (404 when it is not in the current graph or not the
 * viewer's to see). A draft carries `reasons` (per op: verdict, reason code, details), `summary` and `groups`.
 */
export const GET = route<Ctx>(async (req, v, ctx) => {
  const { id } = idParams.parse(await ctx.params);
  const { context } = query(req, q);
  const changeSet = await getChangeSet(v, id);
  if (!changeSet) throw new HttpError(404, "We couldn't find that proposal.");
  return context ? { changeSet, context: await reviewContext(v, changeSet) } : { changeSet };
});
