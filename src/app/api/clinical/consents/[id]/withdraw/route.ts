import { parseBody, parseParam, route, uuid } from "@/lib/clinical/http";
import { withdrawConsent } from "@/lib/clinical";
import { withdrawBody } from "@/lib/clinical/schemas";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };
const idOf = async (ctx: Ctx) => parseParam((await ctx.params).id, uuid);

/** POST { note }: the client withdrew their consent. Recording stops, analysis is hidden, sharing ends. */
export const POST = route<Ctx>(async (req, v, ctx) => { await withdrawConsent(v, await idOf(ctx), (await parseBody(req, withdrawBody)).note); return { ok: true }; });
