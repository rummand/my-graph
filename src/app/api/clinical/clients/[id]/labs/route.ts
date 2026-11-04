import { NextResponse } from "next/server";
import { parseBody, parseParam, route, uuid } from "@/lib/clinical/http";
import { importLabs } from "@/lib/clinical";
import { labsBody } from "@/lib/clinical/schemas";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };
const idOf = async (ctx: Ctx) => parseParam((await ctx.params).id, uuid);

/** POST { sourceId }: read lab values from an uploaded result; they come back as proposals to confirm. */
export const POST = route<Ctx>(async (req, v, ctx) => {
  const b = await parseBody(req, labsBody);
  return NextResponse.json(await importLabs(v, await idOf(ctx), b.sourceId, b.sessionId ?? null), { status: 201 });
});
