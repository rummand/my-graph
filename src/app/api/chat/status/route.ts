import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { handle } from "@/lib/assistant/http";
import { muxHealth } from "@/lib/mux";

export const dynamic = "force-dynamic";

/** GET /api/chat/status — can the assistant reach mux? (for the banner on /chat) */
export function GET(req: Request) {
  return handle(async () => {
    await requireUser();
    const fresh = new URL(req.url).searchParams.has("fresh");
    const h = await muxHealth({ fresh });
    return NextResponse.json({ ok: h.ok, reachable: h.reachable, configured: h.configured, detail: h.detail });
  });
}
