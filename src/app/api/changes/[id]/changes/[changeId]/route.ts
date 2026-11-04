import { z } from "zod";
import { body, HttpError, route } from "@/lib/changes/http";
import { setIncluded } from "@/lib/changes/store";

type Ctx = { params: Promise<{ id: string; changeId: string }> };
const params = z.object({ id: z.uuid(), changeId: z.uuid() });
const schema = z.object({ included: z.boolean() }).strict();

/** PATCH /api/changes/:id/changes/:changeId { included } → { ok, fingerprint } — tick or untick one change. */
export const PATCH = route<Ctx>(async (req, v, ctx) => {
  const { id, changeId } = params.parse(await ctx.params);
  const { included } = await body(req, schema);
  const r = await setIncluded(v, id, changeId, included);
  if (!r) throw new HttpError(404, "We couldn't find that change.");
  return { ok: true, fingerprint: r.fingerprint };
});
