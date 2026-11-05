import { z } from "zod";
import { handle, jsonBody } from "@/lib/meta/http";
import { lexiconEtag, lexiconStamp, streamSentences } from "@/lib/mentions/live/server";

const input = z.object({
  sentences: z.array(z.object({ key: z.string().max(40).optional(), text: z.string().trim().min(1).max(1000) })).min(1).max(20),
  sensitive: z.boolean().optional(),
});

/**
 * POST /api/annotate/stream { sentences: [{ key, text }], sensitive? } — NDJSON, one event per line, as soon as each
 * part is ready: `det` (dates, links … for every sentence) first, then `model` per sentence (cached per sentence, so
 * a sentence is read once), or `muxDown`. Header `x-lexicon` = the current lexicon ETag. Reads only; nothing is written.
 */
export const POST = handle(async (req, v) => {
  const body = await jsonBody(req, input);
  const enc = new TextEncoder();
  const stamp = await lexiconStamp(v);
  const events = streamSentences(v, body, stamp);
  const stream = new ReadableStream<Uint8Array>({
    async pull(c) {
      try {
        const { value, done } = await events.next();
        if (done) c.close();
        else c.enqueue(enc.encode(`${JSON.stringify(value)}\n`));
      } catch (e) {
        console.error("[annotate stream]", e);
        c.enqueue(enc.encode(`${JSON.stringify({ t: "error", key: "", error: "Highlights stopped." })}\n`));
        c.close();
      }
    },
    async cancel() { await events.return(undefined); },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no",
    // The lexicon this was read against: when it differs from the composer's copy, the composer revalidates.
    "x-lexicon": lexiconEtag(v, stamp) } });
});
