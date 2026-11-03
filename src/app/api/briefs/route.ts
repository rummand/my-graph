import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { BriefUnavailableError, cachedBriefFor, generateBrief } from "@/lib/briefs/generate";
import { briefRequestSchema, firstIssue } from "@/lib/briefs/schemas";
import { handle, jsonError, readJson } from "@/lib/briefs/http";

export const dynamic = "force-dynamic";

/** GET /api/briefs — today's cached brief, or { brief: null }. */
export function GET() {
  return handle(async () => {
    const v = await requireUser();
    return NextResponse.json({ brief: cachedBriefFor(v) });
  });
}

/** POST /api/briefs { refresh? } — write today's brief (cached per user per day unless refresh). */
export function POST(req: Request) {
  return handle(async () => {
    const v = await requireUser();
    const body = await readJson(req);
    if (body === null) return jsonError(400, "Send the request as JSON.");
    const parsed = briefRequestSchema.safeParse(body);
    if (!parsed.success) return jsonError(400, firstIssue(parsed.error));
    try {
      const brief = await generateBrief(v, { refresh: parsed.data.refresh });
      return NextResponse.json({ brief });
    } catch (err) {
      if (err instanceof BriefUnavailableError) return jsonError(503, err.message, { code: "mux_unavailable" });
      throw err;
    }
  });
}
