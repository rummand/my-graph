import { NextResponse } from "next/server";
import { parseBody, parseParam, route, uuid } from "@/lib/clinical/http";
import { createSession } from "@/lib/clinical";
import { sessionBody } from "@/lib/clinical/schemas";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };
const idOf = async (ctx: Ctx) => parseParam((await ctx.params).id, uuid);

/** POST { startsAt, title, language }: a new session or consultation. */
export const POST = route<Ctx>(async (req, v, ctx) => NextResponse.json(await createSession(v, await idOf(ctx), await parseBody(req, sessionBody)), { status: 201 }));
