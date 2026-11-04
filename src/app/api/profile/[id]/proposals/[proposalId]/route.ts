import { z } from "zod";
import { decideProposal } from "@/lib/profile";
import { jsonOf, profileRoute } from "@/lib/profile/http";

type Ctx = { params: Promise<{ id: string; proposalId: string }> };
const params = z.object({ id: z.uuid(), proposalId: z.uuid() });
const schema = z.object({ decision: z.enum(["deliver", "drop"]) }).strict();

/** POST /api/profile/:id/proposals/:proposalId { decision } → { version }. Deliver or drop a restore proposal. */
export const POST = profileRoute<Ctx>(async (req, v, ctx) => {
  const { id, proposalId } = params.parse(await ctx.params);
  const { decision } = await jsonOf(req, schema);
  return decideProposal(v, id, proposalId, decision);
});
