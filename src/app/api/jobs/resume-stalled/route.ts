import { NextResponse } from "next/server";
import { z } from "zod";
import { jsonError, withViewer } from "@/lib/ingest/http";
import { resumeStalled } from "@/lib/jobs/manage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const body = z.object({}).strict();

/** POST /api/jobs/resume-stalled — put every stalled file of the viewer's graph back in the reading queue. */
export async function POST(req: Request) {
  return withViewer(async (v) => {
    const text = await req.text();
    let raw: unknown = {};
    if (text.trim()) {
      try { raw = JSON.parse(text); } catch { return jsonError(400, "Send no body, or an empty JSON object."); }
    }
    body.parse(raw);
    const r = await resumeStalled(v);
    return NextResponse.json(r, { status: 202 });
  });
}
