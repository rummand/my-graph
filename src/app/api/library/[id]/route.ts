import { NextResponse } from "next/server";
import { z } from "zod";
import { idParam, jsonError, withViewer } from "@/lib/ingest/http";
import { deleteSource, getSourceDetail, updateSource } from "@/lib/ingest/library";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/library/:id — the source with its chunks, extracted entities and facts. */
export async function GET(_req: Request, ctx: Ctx) {
  return withViewer(async (v) => {
    const { id } = idParam.parse(await ctx.params);
    const d = await getSourceDetail(v, id);
    if (!d) return jsonError(404, "This file doesn't exist or you don't have access to it.");
    return NextResponse.json(d);
  });
}

const patchBody = z.object({
  title: z.string().trim().min(1, "Give the file a name.").max(250, "Keep the name under 250 characters.").optional(),
  visibility: z.enum(["private", "parents", "household"]).optional(),
  sensitive: z.boolean().optional(),
}).strict();

/** PATCH /api/library/:id — { title?, visibility?, sensitive? } (owner only). */
export async function PATCH(req: Request, ctx: Ctx) {
  return withViewer(async (v) => {
    const { id } = idParam.parse(await ctx.params);
    const body = patchBody.parse(await req.json().catch(() => ({})));
    const source = await updateSource(v, id, body);
    return NextResponse.json({ source });
  });
}

/** DELETE /api/library/:id — removes the source, its chunks and document node; the file too if nothing else uses it. */
export async function DELETE(_req: Request, ctx: Ctx) {
  return withViewer(async (v) => {
    const { id } = idParam.parse(await ctx.params);
    const r = await deleteSource(v, id);
    return NextResponse.json({ ok: true, ...r });
  });
}
