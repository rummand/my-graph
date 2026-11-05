import { addYouIdea } from "@/lib/you";
import { insightParams, youRoute } from "@/lib/you/http";

type Ctx = { params: Promise<{ id: string }> };

/** POST /api/you/insights/:id/idea → add the suggested reminder to Automations, switched off until the person turns it on. */
export const POST = youRoute<Ctx>(async (_req, v, ctx) => {
  const { id } = insightParams.parse(await ctx.params);
  return addYouIdea(v, id);
});
