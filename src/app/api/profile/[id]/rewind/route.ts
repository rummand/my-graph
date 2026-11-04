import { z } from "zod";
import { getT } from "@/lib/i18n";
import { readableNode } from "@/lib/profile";
import { jsonOf, nodeParams, profileRoute } from "@/lib/profile/http";
import { proposeNodeRewind } from "@/lib/profile/rewind";

type Ctx = { params: Promise<{ id: string }> };
const schema = z.object({ at: z.string().trim().max(40).refine((s) => !Number.isNaN(Date.parse(s)), "Not a date") }).strict();

/**
 * POST /api/profile/:id/rewind { at } → { changeSetId, ops }. Proposes putting this node and its facts back the way
 * they were at `at` (a change set to review; nothing changes yet). `changeSetId` null: nothing to restore.
 */
export const POST = profileRoute<Ctx>(async (req, v, ctx) => {
  const { id } = nodeParams.parse(await ctx.params);
  const { at } = await jsonOf(req, schema);
  const [t, node] = await Promise.all([getT(), readableNode(v, id)]);
  return proposeNodeRewind(v, node.id, new Date(at), t("profile.history.rewindTitle", { name: node.label }), t("profile.history.rewindNote"));
});
