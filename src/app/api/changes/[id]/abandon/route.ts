import { abandonChangeSet, getChangeSet } from "@/lib/changes";
import { HttpError, idParams, route } from "@/lib/changes/http";

type Ctx = { params: Promise<{ id: string }> };

/** POST /api/changes/:id/abandon → { ok, changeSet } — drop a proposal; nothing in it reaches the graph. */
export const POST = route<Ctx>(async (_req, v, ctx) => {
  const { id } = idParams.parse(await ctx.params);
  const cs = await getChangeSet(v, id);
  if (!cs) throw new HttpError(404, "We couldn't find that proposal.");
  if (cs.status !== "draft") throw new HttpError(409, "This proposal has already been decided.");
  const ok = await abandonChangeSet(v, id);
  if (!ok) throw new HttpError(409, "This proposal has already been decided.");
  return { ok, changeSet: await getChangeSet(v, id) };
});
