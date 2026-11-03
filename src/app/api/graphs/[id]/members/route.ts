import { addMemberByEmail, listMembers } from "@/lib/graphs";
import { addMemberBody, inviteCreateLimiter, limit, parseJson, parseParam, route, uuid } from "@/lib/graphs/http";

type Ctx = { params: Promise<{ id: string }> };
const NOT_FOUND = "That graph doesn't exist, or you're not in it.";

/** GET: who is in this graph (and, for the owner, open invites). Members of the graph only. */
export const GET = route(async (_req, v, ctx: Ctx) => {
  const id = parseParam((await ctx.params).id, uuid, NOT_FOUND);
  return listMembers(v, id);
});

/** POST { email, role }: add someone who already has an account (owner only). */
export const POST = route(async (req, v, ctx: Ctx) => {
  const id = parseParam((await ctx.params).id, uuid, NOT_FOUND);
  const body = await parseJson(req, addMemberBody);
  limit(inviteCreateLimiter, `user:${v.id}`);
  const member = await addMemberByEmail(v, id, body);
  return Response.json({ member }, { status: 201 });
});
