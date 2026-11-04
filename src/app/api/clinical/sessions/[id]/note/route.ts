import { parseParam, route, uuid } from "@/lib/clinical/http";
import { blankNote, loadSession } from "@/lib/clinical";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };
const idOf = async (ctx: Ctx) => parseParam((await ctx.params).id, uuid);

/** POST: start an empty note to write by hand. */
export const POST = route<Ctx>(async (_req, v, ctx) => {
  const { session } = await loadSession(v, await idOf(ctx), "write");
  return { item: await blankNote(v, session.id, session.clientNodeId) };
});
