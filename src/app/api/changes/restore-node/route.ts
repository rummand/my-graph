import { z } from "zod";
import { proposeRestoreNode } from "@/lib/changes/restore";
import { body, HttpError, route } from "@/lib/changes/http";
import { getLocale } from "@/lib/i18n";

const schema = z.object({ nodeId: z.uuid({ message: "Not a valid id" }) }).strict();

/**
 * POST /api/changes/restore-node { nodeId } → { changeSetId }. "Restore as a proposal" for a retired node: the ops
 * (clear the retired marker, give back the facts replaced when it was retired) wait in a change set for a person.
 * Same-origin only (middleware CSRF check on /api).
 */
export const POST = route(async (req, v) => {
  const { nodeId } = await body(req, schema);
  const r = await proposeRestoreNode(v, nodeId, await getLocale());
  if (!r.ok) throw new HttpError(r.status, r.error);
  return { changeSetId: r.changeSetId };
});
