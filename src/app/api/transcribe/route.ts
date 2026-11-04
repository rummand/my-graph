import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import * as mux from "@/lib/mux";
import { firstIssue, handle, jsonError } from "@/lib/assistant/http";
import { checkAudio, dictationLanguageSchema, MAX_DICTATION_BYTES } from "@/lib/assistant/transcribe";
import { AttemptLimiter } from "@/lib/auth/rate-limit";

const g = globalThis as unknown as { __mgDictationLimiter?: AttemptLimiter };
/** 30 dictations a minute per person: enough for anyone talking, not enough to run up the speech model. */
const limiter = g.__mgDictationLimiter ?? (g.__mgDictationLimiter = new AttemptLimiter(30, 60 * 1000));

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/transcribe (multipart: audio, language?) — dictation where the browser can't recognise speech itself.
 * The audio goes to mux (Whisper) with no fallback (what people dictate can be private) and is not stored.
 * Answers { text }.
 */
export function POST(req: Request) {
  return handle(async () => {
    const v = await requireUser();
    const key = `dictation|${v.id}`;
    const room = limiter.check(key);
    if (!room.allowed) return jsonError(429, "That's a lot of dictation in a short time. Wait a moment and try again.", { retryAfterSec: room.retryAfterSec });
    limiter.fail(key);
    if (!req.headers.get("content-type")?.toLowerCase().startsWith("multipart/form-data")) {
      return jsonError(415, "Send the recording as a form with an “audio” field.");
    }
    const declared = Number(req.headers.get("content-length") ?? 0);
    if (declared > MAX_DICTATION_BYTES + 64 * 1024) return jsonError(413, "That recording is too long. Keep dictation under a few minutes.");
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return jsonError(400, "Send the recording as a form with an “audio” field.");
    }
    const raw = form.get("audio");
    const audio = raw instanceof Blob ? raw : null;
    const check = checkAudio(audio);
    if (!check.ok) return jsonError(check.status, check.error);
    const lang = dictationLanguageSchema.safeParse(form.get("language") ?? undefined);
    if (!lang.success) return jsonError(400, firstIssue(lang.error));
    try {
      const r = await mux.transcribe(audio!, `dictation.${check.ext}`, { userId: v.id, agent: "my-graph:dictation", sensitive: true, graphId: v.graphId });
      return NextResponse.json({ text: r.text.trim(), language: lang.data ?? null });
    } catch (e) {
      if (e instanceof mux.MuxAuthError || e instanceof mux.MuxUnavailableError) {
        return jsonError(503, "Speech to text isn't available right now: the model gateway can't be reached. Try again, or type instead.");
      }
      console.error("[transcribe]", e);
      return jsonError(502, "Couldn't turn that into text. Try again or type instead.");
    }
  });
}
