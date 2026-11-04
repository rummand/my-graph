import { NextResponse } from "next/server";
import { parseBody, parseParam, route, uuid } from "@/lib/clinical/http";
import { draftSummary } from "@/lib/clinical";
import { summaryBody } from "@/lib/clinical/schemas";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };
const idOf = async (ctx: Ctx) => parseParam((await ctx.params).id, uuid);

/** POST { lang }: a summary to read before the next consultation. */
export const POST = route<Ctx>(async (req, v, ctx) => NextResponse.json({ item: await draftSummary(v, await idOf(ctx), (await parseBody(req, summaryBody)).lang) }, { status: 201 }));
