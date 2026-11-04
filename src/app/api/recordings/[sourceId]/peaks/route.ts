import { NextResponse } from "next/server";
import { makeLimiter } from "@/lib/connectors/record/audio-proxy";
import { peaksFor } from "@/lib/connectors/record/recordings";
import { RecordingsError, recordingsRoute, sourceIdOf } from "@/lib/connectors/record/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const g = globalThis as unknown as { __mgPeaksLimit?: ReturnType<typeof makeLimiter> };
const allow = (g.__mgPeaksLimit ??= makeLimiter(60));

/** GET: { durationMs, peaks (0–1, or null when Record sent none), hasAudio }, kept once fetched. 404 when there is no sound. */
export const GET = recordingsRoute(async (_req, v, { params }: { params: Promise<{ sourceId: string }> }) => {
  const id = await sourceIdOf(params);
  if (!allow(v.id)) throw new RecordingsError(429, "Too many requests. Wait a moment.");
  const p = await peaksFor(v, id);
  if (!p) throw new RecordingsError(404, "This recording doesn't exist, or you can't play it.");
  if (!p.hasAudio) return NextResponse.json({ error: "Record has no sound for this meeting.", hasAudio: false }, { status: 404 });
  return NextResponse.json(p, { headers: { "cache-control": "private, max-age=300" } });
});
