/**
 * Step 1 of the pipeline: turn an original file into text segments with locators. Server-only.
 * PDF (unpdf per page; scanned pages read as pictures) · DOCX (mammoth) · PowerPoint (formats/pptx, per slide) ·
 * spreadsheets and CSV (formats/sheet, per sheet and range) · text/markdown · email (.eml) · pictures (formats/image:
 * mux's vision route reads the text verbatim and describes the picture; bundled tesseract eng+dan when mux is down;
 * EXIF date/GPS) · audio (mux transcription, timed segments). Readers live in ./formats.
 */
import * as mux from "@/lib/mux";
import type { TextSegment } from "./chunk";
import { letterDate } from "./document-date";
import { emailToText, parseEmail } from "./email";
import { extractImage } from "./formats/image";
import { extractPdf } from "./formats/pdf";
import { extractPptx } from "./formats/pptx";
import { extractSpreadsheet } from "./formats/sheet";
import { decodeText } from "./formats/text";
import type { ExtractedText } from "./formats/types";
import { participantsOf, threadKeyFor } from "./mail";
import type { FileKind } from "./mime";

export type { ExtractedText } from "./formats/types";
export { decodeText } from "./formats/text";

export async function extractText(opts: {
  bytes: Buffer; mime: string; kind: FileKind; filename: string; sensitive: boolean; muxUp: boolean; muxMeta: mux.MuxCallMeta;
}): Promise<ExtractedText> {
  switch (opts.kind) {
    case "pdf": return withLetterDate(await extractPdf(opts));
    case "docx": return withLetterDate(await extractDocx(opts.bytes));
    case "pptx": return withLetterDate(await extractPptx(opts));
    case "spreadsheet": return extractSpreadsheet(opts);
    case "text": return withLetterDate(plain(decodeText(opts.bytes)));
    case "email": return extractEmail(opts.bytes);
    case "image": return extractImage(opts);
    case "audio": return extractAudio(opts);
    case "mailbox": case "archive": throw new Error("A mail import is split into messages, not read as one document.");
  }
}

/** Add the letterhead / "Dato:" date of a text to what a reader found. */
function withLetterDate(x: ExtractedText, text = x.textContent): ExtractedText {
  const d = letterDate(text);
  return d ? { ...x, dates: [...(x.dates ?? []), d] } : x;
}

function plain(text: string, extra: Partial<ExtractedText> = {}): ExtractedText {
  const t = text.replace(/\r\n/g, "\n");
  return { segments: [{ text: t }], textContent: t, meta: {}, warnings: [], activity: "upload", ...extra };
}

async function extractDocx(bytes: Buffer): Promise<ExtractedText> {
  const mammoth = (await import("mammoth")).default;
  const r = await mammoth.extractRawText({ buffer: bytes });
  return plain(r.value.replace(/\n{3,}/g, "\n\n").trim());
}

function extractEmail(bytes: Buffer): ExtractedText {
  const e = parseEmail(decodeText(bytes));
  return plain(emailToText(e), {
    meta: {
      email: {
        subject: e.subject ?? null, from: e.from ?? null, to: e.to ?? null, cc: e.cc ?? null, date: e.date?.toISOString() ?? null,
        attachments: e.attachments, messageId: e.messageId ?? null, inReplyTo: e.inReplyTo ?? null, references: e.references.slice(0, 50),
        participants: participantsOf(e).slice(0, 60),
      },
    },
    occurredAt: e.date,
    dates: e.date ? [{ at: e.date, precision: "minute", origin: "email" }] : [],
    threadKey: threadKeyFor(e),
    externalId: e.messageId ?? null,
  });
}

async function extractAudio(opts: { bytes: Buffer; mime: string; filename: string; muxUp: boolean; muxMeta: mux.MuxCallMeta }): Promise<ExtractedText> {
  if (!opts.muxUp) {
    return { segments: [], textContent: "", meta: { transcription: "skipped: mux unreachable" }, warnings: ["The recording is saved, but it couldn't be transcribed because the model gateway (mux) is unreachable. Retry later."], activity: "upload" };
  }
  const r = await mux.transcribe(new Blob([new Uint8Array(opts.bytes)], { type: opts.mime }), opts.filename, opts.muxMeta);
  const segs = (r.segments ?? []).filter((s) => s.text.trim());
  const segments: TextSegment[] = segs.length
    ? segs.map((s) => ({ text: s.text.trim(), timeStartSec: s.start, timeEndSec: s.end }))
    : r.text.trim() ? [{ text: r.text.trim(), timeStartSec: 0 }] : [];
  const duration = segs.length ? segs[segs.length - 1].end : undefined;
  return {
    segments,
    textContent: r.text.trim() || segments.map((s) => s.text).join(" "),
    meta: { transcription: "done", durationSec: duration ?? null },
    warnings: segments.length ? [] : ["No speech was found in the recording."],
    activity: "transcription",
  };
}
