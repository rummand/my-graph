/**
 * Step 1 of the pipeline: turn an original file into text segments with locators. Server-only.
 * PDF (unpdf, per page) · DOCX (mammoth) · text/markdown/csv · email (.eml) · images (OCR with tesseract.js eng+dan,
 * EXIF date/GPS with exifr, a caption from mux's vision route) · audio (mux transcription, timed segments).
 */
import path from "node:path";
import * as mux from "@/lib/mux";
import { uploadDir } from "@/lib/storage";
import type { TextSegment } from "./chunk";
import { letterDate, parsePdfDate, type DateCandidate } from "./document-date";
import { emailToText, parseEmail } from "./email";
import { participantsOf, threadKeyFor } from "./mail";
import type { FileKind } from "./mime";

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

const MAX_CAPTION_BYTES = 8 * 1024 * 1024;
const OCR_TIMEOUT_MS = 90_000;

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`${what} took longer than ${Math.round(ms / 1000)} s`)), ms); }),
  ]);
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

export async function extractText(opts: {
  bytes: Buffer; mime: string; kind: FileKind; filename: string; sensitive: boolean; muxUp: boolean; muxMeta: mux.MuxCallMeta;
}): Promise<ExtractedText> {
  switch (opts.kind) {
    case "pdf": return withLetterDate(await extractPdf(opts.bytes));
    case "docx": return withLetterDate(await extractDocx(opts.bytes));
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

export function decodeText(bytes: Buffer): string {
  // Strip a UTF-8 BOM; fall back to latin1 for old Windows exports that aren't valid UTF-8.
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^﻿/, "");
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

function plain(text: string, extra: Partial<ExtractedText> = {}): ExtractedText {
  const t = text.replace(/\r\n/g, "\n");
  return { segments: [{ text: t }], textContent: t, meta: {}, warnings: [], activity: "upload", ...extra };
}

async function extractPdf(bytes: Buffer): Promise<ExtractedText> {
  const { getDocumentProxy, extractText: pdfText } = await import("unpdf");
  const { getMeta } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { totalPages, text } = await pdfText(pdf, { mergePages: false });
  const dates: DateCandidate[] = [];
  try {
    const { info } = await getMeta(pdf);
    const created = parsePdfDate(info?.CreationDate) ?? parsePdfDate(info?.ModDate);
    if (created) dates.push({ at: created, precision: "minute", origin: "pdf" });
  } catch { /* no metadata */ }
  const pages = text.map((t) => t.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").trim());
  const warnings: string[] = [];
  const chars = pages.reduce((n, p) => n + p.length, 0);
  if (chars < 20 * Math.max(1, totalPages)) {
    warnings.push("This PDF has little or no text layer (it may be a scan). Only the text it contains was read.");
  }
  return {
    segments: pages.map((t, i) => ({ text: t, page: i + 1 })),
    textContent: pages.join("\n\f\n"),
    meta: { pages: totalPages },
    warnings,
    activity: "upload",
    dates,
  };
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

async function readExif(bytes: Buffer): Promise<{ takenAt?: Date; lat?: number; lon?: number; camera?: string } | null> {
  try {
    const exifr = (await import("exifr")).default;
    const x = await exifr.parse(bytes, { gps: true, tiff: true, exif: true, pick: ["DateTimeOriginal", "CreateDate", "Make", "Model", "latitude", "longitude", "GPSLatitude", "GPSLongitude"] });
    if (!x) return null;
    const when = x.DateTimeOriginal ?? x.CreateDate;
    const takenAt = when instanceof Date && !Number.isNaN(when.getTime()) ? when : undefined;
    const lat = typeof x.latitude === "number" && Number.isFinite(x.latitude) ? x.latitude : undefined;
    const lon = typeof x.longitude === "number" && Number.isFinite(x.longitude) ? x.longitude : undefined;
    const camera = [x.Make, x.Model].filter((s) => typeof s === "string" && s.trim()).join(" ").trim() || undefined;
    return { takenAt, lat, lon, camera };
  } catch {
    return null;
  }
}

async function ocr(bytes: Buffer): Promise<string> {
  const { createWorker } = await import("tesseract.js");
  const worker = await createWorker(["eng", "dan"], 1, { cachePath: path.join(uploadDir(), "..", "tesseract-cache"), logger: () => {} });
  try {
    const r = await withTimeout(worker.recognize(bytes), OCR_TIMEOUT_MS, "Reading text in the image");
    // Tesseract hallucinates noise on photos without text; keep it only if it contains real words.
    const text = r.data.text.replace(/[ \t]+\n/g, "\n").trim();
    const words = text.split(/\s+/).filter((w) => /[\p{L}]{3,}/u.test(w));
    return r.data.confidence >= 45 && words.length >= 3 ? text : "";
  } finally {
    await worker.terminate().catch(() => {});
  }
}

async function caption(bytes: Buffer, mime: string, meta: mux.MuxCallMeta): Promise<{ text: string; model: string | null }> {
  const url = `data:${mime};base64,${bytes.toString("base64")}`;
  const r = await mux.complete({
    route: "vision",
    maxTokens: 300,
    temperature: 0.2,
    meta,
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "Describe this photo or scan in 1–3 plain sentences for a searchable archive: who/what is visible (no guesses at names), the setting, any visible text, dates or event. If it is a document or letter, say what kind and its subject." },
        { type: "image_url", image_url: { url } },
      ],
    }],
  });
  return { text: r.text.trim(), model: r.model };
}

async function extractImage(opts: { bytes: Buffer; mime: string; sensitive: boolean; muxUp: boolean; muxMeta: mux.MuxCallMeta }): Promise<ExtractedText> {
  const warnings: string[] = [];
  const meta: Record<string, unknown> = {};
  const exif = await readExif(opts.bytes);
  if (exif) meta.exif = { takenAt: exif.takenAt?.toISOString() ?? null, lat: exif.lat ?? null, lon: exif.lon ?? null, camera: exif.camera ?? null };

  let ocrText = "";
  if (opts.mime === "image/heic") {
    meta.ocr = "skipped: HEIC photos can't be read for text yet";
  } else {
    try {
      ocrText = await ocr(opts.bytes);
      meta.ocr = ocrText ? "done" : "no text found";
    } catch (e) {
      meta.ocr = `failed: ${errText(e)}`;
      warnings.push("Couldn't read text in the image.");
    }
  }

  let captionText = "";
  if (opts.sensitive) meta.caption = "skipped: sensitive";
  else if (!opts.muxUp) meta.caption = "skipped: mux unreachable";
  else if (opts.bytes.byteLength > MAX_CAPTION_BYTES) meta.caption = "skipped: image too large to describe";
  else {
    try {
      const c = await caption(opts.bytes, opts.mime, opts.muxMeta);
      captionText = c.text;
      meta.caption = captionText ? "done" : "empty";
      meta.captionText = captionText || null;
      meta.captionModel = c.model;
    } catch (e) {
      meta.caption = `failed: ${errText(e)}`;
    }
  }

  const parts: string[] = [];
  if (captionText) parts.push(`Description: ${captionText}`);
  if (exif?.takenAt) parts.push(`Taken: ${exif.takenAt.toISOString().slice(0, 16).replace("T", " ")}`);
  if (ocrText) parts.push(`Text in the image:\n${ocrText}`);
  const text = parts.join("\n\n");
  return {
    segments: text ? [{ text }] : [],
    textContent: text,
    meta,
    warnings,
    occurredAt: exif?.takenAt,
    activity: ocrText ? "ocr" : "upload",
    dates: [
      ...(exif?.takenAt ? [{ at: exif.takenAt, precision: "minute" as const, origin: "exif" as const }] : []),
      ...(ocrText ? [letterDate(ocrText)].filter((d): d is DateCandidate => !!d) : []),
    ],
  };
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
