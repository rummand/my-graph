import { parseParam, route, uuid } from "@/lib/clinical/http";
import { clientPage } from "@/lib/clinical/views";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };
const idOf = async (ctx: Ctx) => parseParam((await ctx.params).id, uuid);

/** GET: the whole record (consent first, sessions, notes, measures, medication, labs, letters). */
export const GET = route<Ctx>(async (_req, v, ctx) => clientPage(v, await idOf(ctx)));
