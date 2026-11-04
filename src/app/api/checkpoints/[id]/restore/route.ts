import { HttpError, idParams, route } from "@/lib/changes/http";
import { getCheckpoint, proposeRestore } from "@/lib/history/read";
import { scopeOf } from "@/lib/graphs/pure";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/checkpoints/:id/restore → { changeSetId, ops, skipped } — proposes going back to that moment as a change
 * set (history is never rewritten). Nothing changes until someone delivers it.
 */
export const POST = route<Ctx>(async (_req, v, ctx) => {
  const { id } = idParams.parse(await ctx.params);
  if (!scopeOf(v).canWrite) throw new HttpError(403, "You can look at this graph but not change it.");
  const cp = await getCheckpoint(v, id);
  if (!cp) throw new HttpError(404, "We couldn't find that moment.");
  const r = await proposeRestore(v, cp.at, cp.label);
  return { changeSetId: r.id, ops: r.ops, skipped: r.skipped };
});
