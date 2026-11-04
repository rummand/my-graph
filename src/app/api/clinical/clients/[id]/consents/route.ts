import { NextResponse } from "next/server";
import { parseBody, parseParam, route, uuid } from "@/lib/clinical/http";
import { addConsent } from "@/lib/clinical";
import { consentBody } from "@/lib/clinical/schemas";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };
const idOf = async (ctx: Ctx) => parseParam((await ctx.params).id, uuid);

/** POST: register a signed consent (purposes, named colleagues, signed and review dates, the signed form). */
export const POST = route<Ctx>(async (req, v, ctx) => NextResponse.json(await addConsent(v, await idOf(ctx), await parseBody(req, consentBody)), { status: 201 }));
