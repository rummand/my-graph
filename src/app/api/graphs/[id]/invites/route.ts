import { createInvite } from "@/lib/graphs";
import { inviteBody, inviteCreateLimiter, limit, parseJson, parseParam, publicOrigin, route, uuid } from "@/lib/graphs/http";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST { email, role }: invite someone to this graph (owner only). Someone who already has an account is added
 * straight away (`added: true`); otherwise the answer carries a link to send them: /invite/<token>, valid 14 days.
 * The link is shown once; only its hash is stored.
 */
export const POST = route(async (req, v, ctx: Ctx) => {
  const id = parseParam((await ctx.params).id, uuid, "That graph doesn't exist, or you're not in it.");
  const body = await parseJson(req, inviteBody);
  limit(inviteCreateLimiter, `user:${v.id}`);
  const r = await createInvite(v, id, body);
  if (r.added) return Response.json({ added: true, member: r.member }, { status: 201 });
  return Response.json({ added: false, invite: r.invite, inviteUrl: `${publicOrigin(req)}/invite/${r.token}` }, { status: 201 });
});
