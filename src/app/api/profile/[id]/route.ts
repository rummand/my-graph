import { loadProfile } from "@/lib/profile";
import { nodeParams, profileRoute } from "@/lib/profile/http";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/profile/:id → the living profile of a node (sections, facts, suggestions, written doc) for the viewer. */
export const GET = profileRoute<Ctx>(async (_req, v, ctx) => {
  const { id } = nodeParams.parse(await ctx.params);
  return loadProfile(v, id);
});
