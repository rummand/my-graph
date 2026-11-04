import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { searchParamsToObject, threadQuerySchema } from "@/lib/timeline/schemas";
import { loadThread } from "@/lib/timeline/threads";

export const dynamic = "force-dynamic";

/** GET /api/timeline/thread?ids=<id,id> | ?key=<thread key> → { subject, key, messages } (only messages you may open). */
export async function GET(req: Request) {
  try {
    const v = await requireUser();
    const parsed = threadQuerySchema.safeParse(searchParamsToObject(new URL(req.url).searchParams));
    if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid request." }, { status: 400 });
    const t = await loadThread(v, parsed.data);
    if (!t) return NextResponse.json({ error: "This conversation doesn't exist, or it isn't shared with you." }, { status: 404 });
    return NextResponse.json(t, { headers: { "cache-control": "private, no-store" } });
  } catch (err) {
    if (err instanceof Response) {
      if (err.headers.get("content-type")?.includes("json")) return err;
      return NextResponse.json({ error: "Please sign in again." }, { status: err.status || 401 });
    }
    console.error("[timeline thread api]", err);
    return NextResponse.json({ error: "We couldn't load the conversation. Please try again." }, { status: 500 });
  }
}
