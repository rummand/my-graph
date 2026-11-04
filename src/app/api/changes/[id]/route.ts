import { getChangeSet } from "@/lib/changes";
import { HttpError, idParams, route } from "@/lib/changes/http";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/changes/:id → { changeSet } (404 when it is not in the current graph or not the viewer's to see). */
export const GET = route<Ctx>(async (_req, v, ctx) => {
  const { id } = idParams.parse(await ctx.params);
  const changeSet = await getChangeSet(v, id);
  if (!changeSet) throw new HttpError(404, "We couldn't find that proposal.");
  return { changeSet };
});
