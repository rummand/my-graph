import { historyOf } from "@/lib/changes";
import { listVersions, readableNode } from "@/lib/profile";
import { nodeParams, profileRoute } from "@/lib/profile/http";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/profile/:id/versions → { versions, events }: the written doc's versions and everything the graph's history
 * recorded about this node and its facts (newest first), for the profile's version history panel.
 */
export const GET = profileRoute<Ctx>(async (_req, v, ctx) => {
  const { id } = nodeParams.parse(await ctx.params);
  const node = await readableNode(v, id);
  const [versions, events] = await Promise.all([listVersions(v, node.id, 60), historyOf(v, { subjectId: node.id, limit: 80 })]);
  return { versions, events };
});
