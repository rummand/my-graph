import { z } from "zod";
import { getChangeSet } from "@/lib/changes";
import { body, HttpError, idParams, resolutionSchema, route } from "@/lib/changes/http";
import { reviewContext, updateChanges } from "@/lib/changes/store";

type Ctx = { params: Promise<{ id: string }> };
const schema = z.object({
  changeIds: z.array(z.uuid()).min(1).max(500),
  included: z.boolean().optional(),
  resolution: resolutionSchema.nullable().optional(),
  /** A different decision per change (e.g. "Use them anyway": each one its own existing node). */
  resolutions: z.record(z.uuid(), resolutionSchema.nullable()).optional(),
}).strict().refine((b) => b.included !== undefined || b.resolution !== undefined || b.resolutions !== undefined, "Say what to change: included or resolution.");

/**
 * PATCH /api/changes/:id/changes { changeIds, included?, resolution?, resolutions? } → { ok, fingerprint, changeSet, context }.
 * Tick, untick or decide several changes at once (a group's one-click resolution in the review). The proposal is
 * re-signed, so the new fingerprint (and the verdicts it now gets) come back with it.
 */
export const PATCH = route<Ctx>(async (req, v, ctx) => {
  const { id } = idParams.parse(await ctx.params);
  const input = await body(req, schema);
  const r = await updateChanges(v, id, input);
  if (!r) throw new HttpError(404, "We couldn't find those changes.");
  const changeSet = await getChangeSet(v, id);
  if (!changeSet) throw new HttpError(404, "We couldn't find that proposal.");
  return { ok: true, fingerprint: r.fingerprint, changeSet, context: await reviewContext(v, changeSet) };
});
