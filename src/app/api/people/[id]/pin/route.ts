import { z } from "zod";
import { setPinned } from "@/lib/people/interactions/read";
import { body, HttpError, route, uuid } from "@/lib/people/http";

type Ctx = { params: Promise<{ id: string }> };

/**
 * PUT /api/people/{id}/pin { pinned } — keep someone close (they never fade for you) or let them go again.
 * Per person and graph; nothing anyone else sees changes.
 */
export const PUT = route(async (req, v, ctx: Ctx) => {
  const id = uuid.safeParse((await ctx.params).id);
  if (!id.success) throw new HttpError(404, "That person doesn't exist");
  const { pinned } = await body(req, z.object({ pinned: z.boolean() }));
  if (!(await setPinned(v, id.data, pinned))) throw new HttpError(404, "That person doesn't exist");
  return { pinned };
});
