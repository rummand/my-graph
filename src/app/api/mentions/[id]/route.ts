import { mentionCard } from "@/lib/mentions";
import { ApiError, handle } from "@/lib/meta/http";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/mentions/{nodeId} — the hover card for a mention: kind, key facts, latest change. */
export const GET = handle(async (_req, v, ctx: Ctx) => {
  const card = await mentionCard(v, (await ctx.params).id);
  if (!card) throw new ApiError(404, "That isn't in this graph, or you can't see it.");
  return card;
});
