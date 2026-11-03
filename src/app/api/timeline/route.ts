import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { loadTimeline } from "@/lib/timeline";
import { searchParamsToObject, timelineQuerySchema } from "@/lib/timeline/schemas";

export const dynamic = "force-dynamic";

/**
 * GET /api/timeline?from&to&people=<id,id>&topics=<id,id>&types=event,reminder,source&limit
 * → { lanes, items, topics, people, truncated, from, to, generatedAt }
 */
export async function GET(req: Request) {
  try {
    const v = await requireUser();
    const parsed = timelineQuerySchema.safeParse(searchParamsToObject(new URL(req.url).searchParams));
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      const where = first?.path.join(".");
      return NextResponse.json({ error: first ? `${where ? `${where}: ` : ""}${first.message}` : "Invalid request." }, { status: 400 });
    }
    const data = await loadTimeline(v, parsed.data);
    return NextResponse.json(data, { headers: { "cache-control": "private, no-store" } });
  } catch (err) {
    if (err instanceof Response) {
      if (err.headers.get("content-type")?.includes("json")) return err;
      return NextResponse.json({ error: err.status === 403 ? "You don't have access to this." : "Please sign in again." }, { status: err.status || 401 });
    }
    const status = (err as { status?: unknown })?.status;
    if (typeof status === "number" && status >= 400 && status < 500 && err instanceof Error) {
      return NextResponse.json({ error: err.message }, { status });
    }
    console.error("[timeline api]", err);
    return NextResponse.json({ error: "We couldn't load the timeline. Please try again." }, { status: 500 });
  }
}
