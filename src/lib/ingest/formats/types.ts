import type * as mux from "@/lib/mux";
import type { TextSegment } from "../chunk";
import type { DateCandidate } from "../document-date";

/** What every reader returns (step 1 of the pipeline). */
export type ExtractedText = {
  segments: TextSegment[];
  /** Full text stored on the source. PDF pages are separated by a form feed (\f). */
  textContent: string;
  meta: Record<string, unknown>;
  warnings: string[];
  /** When the content happened (photo taken, email sent) — used for the document node's time. */
  occurredAt?: Date;
  /** How the text was obtained, for provenance. */
  activity: "upload" | "ocr" | "transcription";
  /** Dates the file gives itself (sent, taken, created, printed); the pipeline picks the document date from these. */
  dates?: DateCandidate[];
  /** Email only: the conversation it belongs to. */
  threadKey?: string | null;
  externalId?: string | null;
};

/** What a reader needs to call mux (or decide not to). */
export type ReadContext = { sensitive: boolean; muxUp: boolean; muxMeta: mux.MuxCallMeta };

export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`${what} took longer than ${Math.round(ms / 1000)} s`)), ms); }),
  ]);
}
