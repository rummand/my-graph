import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { rebuildStatus, startRebuild } from "@/lib/timeline/rebuild";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { "cache-control": "private, no-store" };

function fail(err: unknown) {
  if (err instanceof Response) {
    if (err.headers.get("content-type")?.includes("json")) return err;
    return NextResponse.json({ error: err.status === 403 ? "You don't have access to this." : "Please sign in again." }, { status: err.status || 401 });
  }
  console.error("[timeline rebuild api]", err);
  return NextResponse.json({ error: "The rebuild couldn't start. Please try again." }, { status: 500 });
}

/** GET /api/timeline/rebuild → { progress } (null when no rebuild has run in this graph since the server started). */
export async function GET() {
  try {
    const v = await requireUser();
    return NextResponse.json({ progress: await rebuildStatus(v) }, { headers: noStore });
  } catch (err) {
    return fail(err);
  }
}

/** POST /api/timeline/rebuild {} → starts re-reading the library in the background; returns its progress. */
export async function POST(req: Request) {
  try {
    const v = await requireUser();
    const body = await req.json().catch(() => ({}));
    const parsed = z.object({}).strict().safeParse(body ?? {});
    if (!parsed.success) return NextResponse.json({ error: "This takes no options." }, { status: 400 });
    const r = await startRebuild(v);
    if ("error" in r) return NextResponse.json({ error: r.error }, { status: r.status });
    return NextResponse.json({ progress: r.progress, started: r.started }, { status: r.started ? 202 : 200, headers: noStore });
  } catch (err) {
    return fail(err);
  }
}
