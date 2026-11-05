import { z } from "zod";
import { setYouFeedback } from "@/lib/you";
import { insightParams, jsonBody, youRoute } from "@/lib/you/http";

type Ctx = { params: Promise<{ id: string }> };

const answer = z.object({ answer: z.enum(["yes", "no", "hide", "clear"]) }).strict();

/** POST /api/you/insights/:id { answer } → "Is this right?" on one of the person's own patterns. */
export const POST = youRoute<Ctx>(async (req, v, ctx) => {
  const { id } = insightParams.parse(await ctx.params);
  const { answer: a } = await jsonBody(req, answer);
  await setYouFeedback(v, id, a);
  return { ok: true };
});
