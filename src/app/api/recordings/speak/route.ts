import { z } from "zod";
import * as mux from "@/lib/mux";
import { makeLimiter } from "@/lib/connectors/record/audio-proxy";
import { readableRecording } from "@/lib/connectors/record/recordings";
import { RecordingsError, recordingsRoute } from "@/lib/connectors/record/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const g = globalThis as unknown as { __mgSpeakLimit?: ReturnType<typeof makeLimiter> };
const allow = (g.__mgSpeakLimit ??= makeLimiter(90));

const body = z.object({
  /** One sentence (the player asks sentence by sentence, so it knows when each starts). */
  text: z.string().trim().min(1).max(1200),
  language: z.enum(["en", "da"]).optional(),
  /** The recording it is read from, so sensitive ones stay on local models. */
  sourceId: z.uuid().optional(),
});

/**
 * POST { text, language?, sourceId? } → audio (mux text to speech). 503 { error, fallback: "browser" } when mux or its
 * voice is down, so the player reads with the browser's own voice instead.
 */
export const POST = recordingsRoute(async (req, v) => {
  if (!allow(v.id)) throw new RecordingsError(429, "Too many requests. Wait a moment.");
  const b = body.parse(await req.json().catch(() => ({})));
  let sensitive = false;
  if (b.sourceId) {
    const src = await readableRecording(v, b.sourceId);
    if (!src) throw new RecordingsError(404, "This recording doesn't exist, or you can't see it.");
    sensitive = src.sensitive;
  }
  try {
    const s = await mux.speak({ text: b.text, language: b.language ?? "en", meta: { userId: v.id, agent: "recordings-read-aloud", graphId: v.graphId, sensitive, traceId: b.sourceId }, signal: req.signal });
    return new Response(s.audio, { headers: { "content-type": s.mime, "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
  } catch (e) {
    if (e instanceof mux.MuxError) return Response.json({ error: "The voice isn't available right now.", fallback: "browser" }, { status: 503 });
    throw e;
  }
});
