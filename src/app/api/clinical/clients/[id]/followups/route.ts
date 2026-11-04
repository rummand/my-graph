import { NextResponse } from "next/server";
import { parseBody, parseParam, route, uuid } from "@/lib/clinical/http";
import { addFollowup } from "@/lib/clinical";
import { followupBody } from "@/lib/clinical/schemas";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };
const idOf = async (ctx: Ctx) => parseParam((await ctx.params).id, uuid);

/** POST { title, dueAt }: a follow-up of my own. */
export const POST = route<Ctx>(async (req, v, ctx) => NextResponse.json({ item: await addFollowup(v, await idOf(ctx), await parseBody(req, followupBody)) }, { status: 201 }));
