import { NextResponse } from "next/server";
import { z } from "zod";
import { jsonError, withViewer } from "@/lib/ingest/http";
import { cancelJob } from "@/lib/jobs/manage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const params = z.object({ id: z.string().uuid("That isn't a valid queue item.") });

/** POST /api/jobs/:id/cancel — take a waiting item out of the reading queue (people who may write in the graph). */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return withViewer(async (v) => {
    const p = params.safeParse(await ctx.params);
    if (!p.success) return jsonError(400, p.error.issues[0]?.message ?? "Invalid request.");
    await cancelJob(v, p.data.id);
    return NextResponse.json({ ok: true });
  });
}
