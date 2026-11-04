/**
 * Text to speech through mux's /v1/audio/speech (OpenAI's shape; mux's route "speak", Piper on the Mac). Server-only.
 * Used by "Read aloud" for text without sound of its own (a summary, a meeting Record has no sound for).
 * Throws MuxUnavailableError when mux or its speech model is down, so the caller can fall back to the browser's voice.
 */
import { errorFromResponse, MuxAuthError, MuxUnavailableError } from "./errors";
import { buildHeaders, muxConfig, readMuxHeaders } from "./request";
import type { MuxCallMeta } from "./index";

export type Speech = { audio: ArrayBuffer; mime: string; model: string | null };

export async function speak(opts: { text: string; voice?: string; format?: "wav" | "mp3"; language?: "en" | "da"; meta: MuxCallMeta; signal?: AbortSignal }): Promise<Speech> {
  const { baseUrl, apiKey } = muxConfig();
  if (!apiKey) throw new MuxAuthError("mux is not configured: set MUX_API_KEY.", 401, "not_configured");
  const format = opts.format ?? "wav";
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/v1/audio/speech`, {
      method: "POST", cache: "no-store",
      headers: { ...buildHeaders(opts.meta, apiKey, ["speech", ...(opts.language ? [`lang:${opts.language}`] : [])]), "content-type": "application/json" },
      body: JSON.stringify({ model: "speak", input: opts.text.slice(0, 4000), voice: opts.voice ?? (opts.language === "da" ? "da" : "default"), response_format: format }),
      signal: opts.signal ?? AbortSignal.timeout(60_000),
    });
  } catch (e) {
    if ((e as Error)?.name === "AbortError") throw e;
    throw new MuxUnavailableError();
  }
  if (!res.ok) {
    let body: unknown = null;
    try { body = await res.json(); } catch { /* not JSON */ }
    throw errorFromResponse(res.status, body, readMuxHeaders(res.headers).requestId, res.headers.get("retry-after"));
  }
  const mime = (res.headers.get("content-type") ?? (format === "mp3" ? "audio/mpeg" : "audio/wav")).split(";")[0];
  return { audio: await res.arrayBuffer(), mime: mime.startsWith("audio/") ? mime : "audio/wav", model: readMuxHeaders(res.headers).model };
}
