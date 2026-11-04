import { parseParam, route, uuid } from "@/lib/clinical/http";
import { startDraft } from "@/lib/clinical";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };
const idOf = async (ctx: Ctx) => parseParam((await ctx.params).id, uuid);

/** POST: draft the note (and analysis, when consented) again from the transcript. */
export const POST = route<Ctx>(async (_req, v, ctx) => { await startDraft(v, await idOf(ctx)); return { ok: true }; });
