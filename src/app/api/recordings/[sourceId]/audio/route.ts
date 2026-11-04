import { NextResponse } from "next/server";
import { guardedStream } from "@/lib/mcp-client/transport";
import { makeLimiter, passStatus, proxyHeaders, rangeToForward } from "@/lib/connectors/record/audio-proxy";
import { freshAudio, playableSource } from "@/lib/connectors/record/recordings";
import { RecordingsError, recordingsRoute, sourceIdOf } from "@/lib/connectors/record/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// An audio element asks for many ranges while it plays and seeks; 300 a minute per person is plenty and stops abuse.
const g = globalThis as unknown as { __mgAudioLimit?: ReturnType<typeof makeLimiter> };
const allow = (g.__mgAudioLimit ??= makeLimiter(300));

/**
 * GET /api/recordings/:sourceId/audio — the meeting's sound for a signed-in member who may read this recording.
 * Access is checked on every request. The server asks Record (get_meeting_audio, with the connection's own sign-in)
 * for a short-lived signed address and streams it through, passing one Range on and the range headers back. The
 * address and the Record token never reach the browser; nothing is cached beyond the address's own life; no redirect.
 */
export const GET = recordingsRoute(async (req, v, { params }: { params: Promise<{ sourceId: string }> }) => {
  const id = await sourceIdOf(params);
  if (!allow(v.id)) throw new RecordingsError(429, "Too many requests for sound. Wait a moment.");
  const src = await playableSource(v, id);
  if (!src) throw new RecordingsError(404, "This recording doesn't exist, or you can't play it.");
  const range = rangeToForward(req.headers.get("range"));
  const headers = { accept: "audio/*", ...(range ? { range } : {}) };

  for (let attempt = 0; attempt < 2; attempt++) {
    const signed = await freshAudio(src, { force: attempt > 0 });
    const up = await guardedStream({ url: signed.url, method: "GET", headers, timeoutMs: 30_000, signal: req.signal, follow: 3 });
    // An address that ran out early: ask Record for a new one, once.
    if ((up.status === 401 || up.status === 403 || up.status === 410) && attempt === 0) { up.abort(); continue; }
    if (!passStatus(up.status)) {
      up.abort();
      throw new RecordingsError(502, `Record didn't give the sound (HTTP ${up.status}).`);
    }
    const out = proxyHeaders(up.headers);
    if (!out) {
      up.abort();
      throw new RecordingsError(502, "Record answered with something that isn't sound.");
    }
    return new NextResponse(up.body, { status: up.status, headers: out });
  }
  throw new RecordingsError(502, "Record's sound address stopped working. Try again.");
});
