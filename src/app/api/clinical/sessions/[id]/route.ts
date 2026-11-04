import { parseParam, route, uuid } from "@/lib/clinical/http";
import { sessionPage } from "@/lib/clinical/views";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };
const idOf = async (ctx: Ctx) => parseParam((await ctx.params).id, uuid);

/** GET: the session with its transcript and drafts (polled while work runs). */
export const GET = route<Ctx>(async (_req, v, ctx) => sessionPage(v, await idOf(ctx)));
