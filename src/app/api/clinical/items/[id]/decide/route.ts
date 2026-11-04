import { parseBody, parseParam, route, uuid } from "@/lib/clinical/http";
import { decide } from "@/lib/clinical";
import { decideBody } from "@/lib/clinical/schemas";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };
const idOf = async (ctx: Ctx) => parseParam((await ctx.params).id, uuid);

/** POST { decision, content?, baseVersion? }: sign, confirm, dismiss, acknowledge, complete or reopen. */
export const POST = route<Ctx>(async (req, v, ctx) => {
  const b = await parseBody(req, decideBody);
  return { item: await decide(v, await idOf(ctx), b.decision, { content: b.content, baseVersion: b.baseVersion }) };
});
