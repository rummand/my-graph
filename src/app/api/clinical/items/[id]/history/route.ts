import { parseParam, route, uuid } from "@/lib/clinical/http";
import { itemHistory } from "@/lib/clinical";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };
const idOf = async (ctx: Ctx) => parseParam((await ctx.params).id, uuid);

/** GET: every version of an item, who made it and when. */
export const GET = route<Ctx>(async (_req, v, ctx) => ({ revisions: await itemHistory(v, await idOf(ctx)) }));
