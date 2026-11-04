import { NextResponse } from "next/server";
import { z } from "zod";
import { withViewer } from "@/lib/ingest/http";
import { graphQueue } from "@/lib/jobs/manage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const query = z.object({ scope: z.enum(["graph"], { message: "scope must be \"graph\"." }).default("graph") }).strict();

/**
 * GET /api/jobs?scope=graph — the reading queue of the viewer's current graph: running (with progress), waiting,
 * failed, files left stalled, and how many run at once. Only jobs for files the viewer may open are named.
 */
export async function GET(req: Request) {
  return withViewer(async (v) => {
    const params = Object.fromEntries(new URL(req.url).searchParams);
    query.parse(params);
    const q = await graphQueue(v);
    return NextResponse.json(q, { headers: { "cache-control": "no-store" } });
  });
}
