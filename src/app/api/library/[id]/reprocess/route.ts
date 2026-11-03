import { NextResponse } from "next/server";
import { reprocessSource } from "@/lib/ingest";
import { idParam, withViewer } from "@/lib/ingest/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST /api/library/:id/reprocess — run text extraction, indexing and fact extraction again (owner only). */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return withViewer(async (v) => {
    const { id } = idParam.parse(await ctx.params);
    await reprocessSource(v, id);
    return NextResponse.json({ ok: true, status: "pending" }, { status: 202 });
  });
}
