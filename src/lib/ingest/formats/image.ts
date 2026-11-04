/**
 * Photos, screenshots and scans uploaded as pictures. Server-only.
 * Vision (mux) reads the visible text verbatim and says what the picture is; tesseract (bundled eng+dan) reads the
 * text only when mux is unreachable. EXIF gives the date taken and place.
 */
import type { TextSegment } from "../chunk";
import { letterDate, type DateCandidate } from "../document-date";
import { packBlocks, readPicture } from "./picture";
import type { ExtractedText, ReadContext } from "./types";

/** The marker classify.ts counts from to tell a scanned letter from a photo. */
export const TEXT_MARKER = "Text in the image:";

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

export async function extractImage(opts: { bytes: Buffer; mime: string } & ReadContext): Promise<ExtractedText> {
  const warnings: string[] = [];
  const meta: Record<string, unknown> = {};
  const exif = await readExif(opts.bytes);
  if (exif) meta.exif = { takenAt: exif.takenAt?.toISOString() ?? null, lat: exif.lat ?? null, lon: exif.lon ?? null, camera: exif.camera ?? null };

  const r = await readPicture(opts.bytes, opts.mime, opts);
  meta.reader = r.reader;
  meta.vision = r.vision;
  // `ocr` keeps its meaning for the rest of the app: was text read off the picture.
  meta.ocr = r.text ? "done" : r.reader ? "no text found" : r.ocr !== "not needed" ? r.ocr : r.vision;
  if (r.reader === "tesseract") meta.tesseract = r.ocr;
  meta.caption = r.description ? "done" : r.reader === "vision" ? "empty" : r.vision;
  meta.captionText = r.description || null;
  meta.captionModel = r.model;
  if (r.kind) meta.pictureKind = r.kind;
  if (r.language) meta.textLanguage = r.language;
  if (r.width && r.height) meta.dimensions = { width: r.width, height: r.height };

  if (!r.reader) {
    if (opts.mime === "image/heic" && !opts.muxUp) warnings.push("HEIC photos are read by the vision model, and the model gateway (mux) is unreachable. Read it again later.");
    else if (!opts.muxUp) warnings.push("Couldn't read text in the picture: the model gateway (mux) is unreachable and the fallback text reader failed.");
    else warnings.push("Couldn't read the picture.");
  } else if (r.reader === "tesseract") {
    warnings.push("Read with the fallback text reader because the model gateway (mux) was unreachable. Read it again later for a description and better text.");
  }

  const head: string[] = [];
  if (r.description) head.push(`Description: ${r.description}`);
  if (exif?.takenAt) head.push(`Taken: ${exif.takenAt.toISOString().slice(0, 16).replace("T", " ")}`);
  const groups = r.text ? packBlocks(r.blocks) : [];
  const segments: TextSegment[] = [];
  groups.forEach((g, i) => {
    const at = { ...(g.region ? { region: g.region } : {}), ...(g.bbox ? { bbox: g.bbox } : {}) };
    const text = i === 0 ? [...head, `${TEXT_MARKER}\n${g.text}`].join("\n\n") : g.text;
    segments.push(Object.keys(at).length ? { text, at } : { text });
  });
  if (!groups.length && head.length) segments.push({ text: head.join("\n\n") });
  const textContent = [...head, ...(r.text ? [`${TEXT_MARKER}\n${groups.map((g) => g.text).join("\n\n")}`] : [])].join("\n\n");

  return {
    segments,
    textContent,
    meta,
    warnings,
    occurredAt: exif?.takenAt,
    activity: r.text ? "ocr" : "upload",
    dates: [
      ...(exif?.takenAt ? [{ at: exif.takenAt, precision: "minute" as const, origin: "exif" as const }] : []),
      ...(r.text ? [letterDate(r.text)].filter((d): d is DateCandidate => !!d) : []),
    ],
  };
}
