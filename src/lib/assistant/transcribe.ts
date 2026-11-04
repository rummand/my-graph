/**
 * Dictation fallback (pure, unit-tested): where the browser can't recognise speech itself, the composer records audio
 * and POSTs it to /api/transcribe, which sends it to mux (Whisper). These are the limits checked at that boundary.
 */
import { z } from "zod";

/** About ten minutes of Opus speech; dictation is a question, not a meeting recording. */
export const MAX_DICTATION_BYTES = 12 * 1024 * 1024;
/** Shorter than this is a click, not speech. */
export const MIN_DICTATION_BYTES = 800;

/** Recorder formats browsers produce (Chrome/Firefox: webm/ogg Opus; Safari: mp4/AAC), and plain uploads. */
const TYPES: Record<string, string> = {
  "audio/webm": "webm",
  "video/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "video/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/m4a": "m4a",
  "audio/aac": "aac",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
};

export type AudioCheck =
  | { ok: true; type: string; ext: string }
  | { ok: false; status: 400 | 413 | 415; error: string };

/** "audio/webm;codecs=opus" → "audio/webm". */
export function baseType(type: string): string {
  return type.split(";")[0].trim().toLowerCase();
}

export function checkAudio(f: { size: number; type: string } | null | undefined): AudioCheck {
  if (!f) return { ok: false, status: 400, error: "Send the recording as the “audio” field." };
  const type = baseType(f.type || "");
  const ext = TYPES[type];
  if (!ext) return { ok: false, status: 415, error: "That recording format isn't supported. Use WebM, Ogg, MP4/M4A, MP3 or WAV audio." };
  if (f.size > MAX_DICTATION_BYTES) return { ok: false, status: 413, error: "That recording is too long. Keep dictation under a few minutes." };
  if (f.size < MIN_DICTATION_BYTES) return { ok: false, status: 400, error: "Didn't hear anything. Try again a little closer to the microphone." };
  return { ok: true, type, ext };
}

/** The dictation language the person picked (Whisper also detects it; this is the hint). */
export const dictationLanguageSchema = z.enum(["da", "en"], { message: "language must be da or en" }).optional();

/** BCP-47 tag for the browser's speech recogniser. */
export function speechLang(lang: "da" | "en"): string {
  return lang === "da" ? "da-DK" : "en-GB";
}

/** The other language, for the DA/EN toggle. */
export const otherLang = (lang: "da" | "en"): "da" | "en" => (lang === "da" ? "en" : "da");

/** Put dictated text after what was already typed, with one space between. */
export function joinDictation(before: string, said: string): string {
  const s = said.replace(/\s+/g, " ").trimStart();
  if (!s) return before;
  if (!before.trim()) return s.charAt(0).toUpperCase() + s.slice(1);
  return /\s$/.test(before) ? `${before}${s}` : `${before} ${s}`;
}
