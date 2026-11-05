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

/**
 * When a photo was taken, as a real moment. EXIF writes the camera's local clock without a zone; exifr turns it into a
 * Date in the server's zone. The clock reading is taken back out and placed with the photo's own offset
 * (OffsetTimeOriginal), else the GPS clock (always UTC), else read as UTC, so the day never depends on the server.
 */
export function exifMoment(x: { DateTimeOriginal?: unknown; CreateDate?: unknown; OffsetTimeOriginal?: unknown; OffsetTime?: unknown; GPSDateStamp?: unknown; GPSTimeStamp?: unknown }): Date | undefined {
  const when = x.DateTimeOriginal ?? x.CreateDate;
  if (!(when instanceof Date) || Number.isNaN(when.getTime())) return undefined;
  const clock = Date.UTC(when.getFullYear(), when.getMonth(), when.getDate(), when.getHours(), when.getMinutes(), when.getSeconds());
  const off = [x.OffsetTimeOriginal, x.OffsetTime].find((o): o is string => typeof o === "string" && /^[+-]\d{2}:\d{2}$/.test(o));
  if (off) {
    const sign = off[0] === "-" ? -1 : 1;
    return new Date(clock - sign * (Number(off.slice(1, 3)) * 60 + Number(off.slice(4, 6))) * 60_000);
  }
  // The GPS clock is UTC; trust it when it is within a day of the camera's clock (a time zone apart, at most).
  if (typeof x.GPSDateStamp === "string" && Array.isArray(x.GPSTimeStamp) && x.GPSTimeStamp.length === 3) {
    const [y, m, d] = x.GPSDateStamp.split(":").map(Number);
    const [hh, mm, ss] = x.GPSTimeStamp.map(Number);
    const gps = Date.UTC(y, m - 1, d, hh, mm, Math.floor(ss));
    if (Number.isFinite(gps) && Math.abs(gps - clock) <= 14 * 3_600_000) return new Date(gps);
  }
  return new Date(clock);
}

/** Date taken, place and camera from EXIF (JPEG, HEIC, PNG, WebP, TIFF: exifr reads them all). */
export async function readExif(bytes: Buffer): Promise<{ takenAt?: Date; lat?: number; lon?: number; camera?: string } | null> {
  try {
    const exifr = (await import("exifr")).default;
    const x = await exifr.parse(bytes, {
      gps: true, tiff: true, exif: true,
      pick: ["DateTimeOriginal", "CreateDate", "OffsetTimeOriginal", "OffsetTime", "Make", "Model", "latitude", "longitude", "GPSLatitude", "GPSLongitude", "GPSLatitudeRef", "GPSLongitudeRef", "GPSDateStamp", "GPSTimeStamp"],
    });
    if (!x) return null;
    const takenAt = exifMoment(x);
    const ok = typeof x.latitude === "number" && typeof x.longitude === "number" && Number.isFinite(x.latitude) && Number.isFinite(x.longitude)
      && Math.abs(x.latitude) <= 90 && Math.abs(x.longitude) <= 180 && !(x.latitude === 0 && x.longitude === 0);
    const camera = [x.Make, x.Model].filter((s) => typeof s === "string" && s.trim()).join(" ").trim() || undefined;
    return { takenAt, lat: ok ? x.latitude : undefined, lon: ok ? x.longitude : undefined, camera };
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
