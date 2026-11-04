import { NextResponse } from "next/server";
import { parseBody, parseParam, route, uuid } from "@/lib/clinical/http";
import { addMeasure } from "@/lib/clinical";
import { measureBody } from "@/lib/clinical/schemas";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };
const idOf = async (ctx: Ctx) => parseParam((await ctx.params).id, uuid);

/** POST { instrument: phq9|gad7, answers, takenAt }: record a measure (scored here). */
export const POST = route<Ctx>(async (req, v, ctx) => NextResponse.json({ item: await addMeasure(v, await idOf(ctx), await parseBody(req, measureBody)) }, { status: 201 }));
