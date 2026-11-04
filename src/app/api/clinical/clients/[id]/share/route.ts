import { parseBody, parseParam, route, uuid } from "@/lib/clinical/http";
import { shareClient, unshareClient } from "@/lib/clinical";
import { shareBody } from "@/lib/clinical/schemas";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };
const idOf = async (ctx: Ctx) => parseParam((await ctx.params).id, uuid);

/** POST { userId }: share the record with a colleague the consent names. DELETE { userId }: stop sharing. */
export const POST = route<Ctx>(async (req, v, ctx) => { await shareClient(v, await idOf(ctx), (await parseBody(req, shareBody)).userId); return { ok: true }; });
export const DELETE = route<Ctx>(async (req, v, ctx) => { await unshareClient(v, await idOf(ctx), (await parseBody(req, shareBody)).userId); return { ok: true }; });
