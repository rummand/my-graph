import { z } from "zod";
import { body, HttpError, resolutionSchema, route } from "@/lib/changes/http";
import { updateChanges } from "@/lib/changes/store";

type Ctx = { params: Promise<{ id: string; changeId: string }> };
const params = z.object({ id: z.uuid(), changeId: z.uuid() });
const schema = z.object({ included: z.boolean().optional(), resolution: resolutionSchema.nullable().optional() }).strict()
  .refine((b) => b.included !== undefined || b.resolution !== undefined, "Say what to change: included or resolution.");

/** PATCH /api/changes/:id/changes/:changeId { included?, resolution? } → { ok, fingerprint } — tick, untick or decide one change. */
export const PATCH = route<Ctx>(async (req, v, ctx) => {
  const { id, changeId } = params.parse(await ctx.params);
  const input = await body(req, schema);
  const r = await updateChanges(v, id, { changeIds: [changeId], ...input });
  if (!r) throw new HttpError(404, "We couldn't find that change.");
  return { ok: true, fingerprint: r.fingerprint };
});
