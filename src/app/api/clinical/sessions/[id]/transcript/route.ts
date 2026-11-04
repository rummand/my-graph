import { parseBody, parseParam, route, uuid } from "@/lib/clinical/http";
import { typedTranscript } from "@/lib/clinical";
import { transcriptBody } from "@/lib/clinical/schemas";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };
const idOf = async (ctx: Ctx) => parseParam((await ctx.params).id, uuid);

/** POST { text }: a typed or pasted transcript; the note is drafted from it. */
export const POST = route<Ctx>(async (req, v, ctx) => { await typedTranscript(v, await idOf(ctx), (await parseBody(req, transcriptBody)).text); return { ok: true }; });
