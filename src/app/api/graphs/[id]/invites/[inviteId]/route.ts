import { revokeInvite } from "@/lib/graphs";
import { parseParam, route, uuid } from "@/lib/graphs/http";

type Ctx = { params: Promise<{ id: string; inviteId: string }> };

/** DELETE: cancel an invite that hasn't been used yet (owner only). */
export const DELETE = route(async (_req, v, ctx: Ctx) => {
  const p = await ctx.params;
  const id = parseParam(p.id, uuid, "That graph doesn't exist, or you're not in it.");
  const inviteId = parseParam(p.inviteId, uuid, "That invite doesn't exist.");
  await revokeInvite(v, id, inviteId);
  return { ok: true };
});
