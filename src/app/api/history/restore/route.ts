import { z } from "zod";
import { body, HttpError, isoDate, route } from "@/lib/changes/http";
import { proposeRestore } from "@/lib/history/read";
import { scopeOf } from "@/lib/graphs/pure";

const schema = z.object({ at: isoDate, label: z.string().trim().min(1).max(120) }).strict();

/** POST /api/history/restore { at, label } → { changeSetId, ops, skipped } — propose going back to any moment. */
export const POST = route(async (req, v) => {
  if (!scopeOf(v).canWrite) throw new HttpError(403, "You can look at this graph but not change it.");
  const { at, label } = await body(req, schema);
  if (at.getTime() > Date.now()) throw new HttpError(400, "Pick a moment in the past.");
  const r = await proposeRestore(v, at, label);
  return { changeSetId: r.id, ops: r.ops, skipped: r.skipped };
});
