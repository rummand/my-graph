import { z } from "zod";
import { deliverChangeSet, getChangeSet } from "@/lib/changes";
import { body, HttpError, idParams, route } from "@/lib/changes/http";

type Ctx = { params: Promise<{ id: string }> };
const schema = z.object({
  onlyChangeIds: z.array(z.uuid()).min(1).max(500).optional(),
  fingerprint: z.string().trim().max(64).optional(),
}).strict();

/**
 * POST /api/changes/:id/deliver { onlyChangeIds?, fingerprint? } → { ok, applied, conflicts, changeSet }.
 * A person decides: the ops land in one transaction with history and provenance. A stale fingerprint is refused (409).
 */
export const POST = route<Ctx>(async (req, v, ctx) => {
  const { id } = idParams.parse(await ctx.params);
  const input = await body(req, schema);
  const before = await getChangeSet(v, id);
  if (!before) throw new HttpError(404, "We couldn't find that proposal.");
  const r = await deliverChangeSet(v, id, input);
  if (!r.ok) {
    const stale = (r as { stale?: boolean }).stale;
    const status = r.conflicts.length || stale ? 409 : /can't change|not change/.test(r.error ?? "") ? 403 : 400;
    throw new HttpError(status, r.error ?? "This couldn't be delivered.", { conflicts: r.conflicts, stale: !!stale });
  }
  return { ...r, changeSet: await getChangeSet(v, id) };
});
