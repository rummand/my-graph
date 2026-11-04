import { clearInsights, generateInsights, readInsights } from "@/lib/profile";
import { nodeParams, profileRoute } from "@/lib/profile/http";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/profile/:id/insights → the viewer's own cached "How they've been doing" (no model call). */
export const GET = profileRoute<Ctx>(async (_req, v, ctx) => {
  const { id } = nodeParams.parse(await ctx.params);
  return readInsights(v, id);
});

/** POST /api/profile/:id/insights → generate or regenerate through mux (sensitive: local models, no fallback). */
export const POST = profileRoute<Ctx>(async (_req, v, ctx) => {
  const { id } = nodeParams.parse(await ctx.params);
  return generateInsights(v, id);
});

/** DELETE /api/profile/:id/insights → forget the viewer's cached insights about this person. */
export const DELETE = profileRoute<Ctx>(async (_req, v, ctx) => {
  const { id } = nodeParams.parse(await ctx.params);
  await clearInsights(v, id);
  return { ok: true };
});
