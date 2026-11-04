import { NextResponse } from "next/server";
import { parseBody, parseParam, route, uuid } from "@/lib/clinical/http";
import { draftLetter } from "@/lib/clinical";
import { letterBody } from "@/lib/clinical/schemas";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };
const idOf = async (ctx: Ctx) => parseParam((await ctx.params).id, uuid);

/** POST { letterKind, recipient, instructions }: draft a letter from the signed record. */
export const POST = route<Ctx>(async (req, v, ctx) => NextResponse.json(await draftLetter(v, await idOf(ctx), await parseBody(req, letterBody)), { status: 201 }));
