/**
 * Is this upload a file we already have, renamed or saved again, or a new version of one? Pure (no DB).
 *
 *   docKey      what survives re-saving: a PDF's document id (XMP DocumentID, else the first /ID of the trailer), an
 *               Office file's creation stamp + author (docProps/core.xml), a photo's capture moment (with sub-seconds)
 *               + camera. A strong sign that two files are versions of one document.
 *   nameKey     the file name without "(1)", "copy", "v2", "final", "endelig" … A weak sign: two files only count as
 *               versions on a name when their texts are also alike (see textSimilarity).
 *   contentKey  a hash of the normalised text: the same text again (renamed and re-saved) is the same file.
 */
import { createHash } from "node:crypto";
import { readZip } from "./zip";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/* ── docKey ──────────────────────────────────────────────────────────────────────────────────────────── */

function latin1(bytes: Uint8Array, from = 0, to = bytes.length): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset + from, Math.max(0, Math.min(to, bytes.length) - from)).toString("latin1");
}

/** A PDF's own identity: XMP DocumentID (kept by editors across saves), else the permanent first half of /ID. */
export function pdfDocKey(bytes: Uint8Array): string | null {
  const text = latin1(bytes);
  const xmp = /xmpMM:DocumentID(?:>|\s*=\s*")\s*([^<"\s]{8,200})/.exec(text)?.[1];
  if (xmp && !/^uuid:0{8}-/.test(xmp)) return `pdf:xmp:${xmp.replace(/^(uuid|xmp\.did):/i, "").toLowerCase()}`;
  // The trailer (or cross-reference stream) /ID [<first><second>]: the first never changes after creation.
  const ids = [...text.matchAll(/\/ID\s*\[\s*<([0-9A-Fa-f]{16,64})>/g)];
  const id = ids.at(-1)?.[1]?.toLowerCase();
  if (!id || /^0+$/.test(id) || /^(.)\1+$/.test(id)) return null;
  return `pdf:id:${id}`;
}

/** Word, PowerPoint and Excel: the moment the document was first created, and by whom (survives every save). */
export function officeDocKey(bytes: Uint8Array, ext: string): string | null {
  try {
    const [core] = readZip(bytes, { maxEntries: 5000, accept: (n) => n === "docProps/core.xml" });
    if (!core) return null;
    const xml = Buffer.from(core.bytes).toString("utf8");
    const created = /<dcterms:created[^>]*>([^<]+)</.exec(xml)?.[1]?.trim();
    if (!created) return null;
    const creator = /<dc:creator[^>]*>([^<]*)</.exec(xml)?.[1]?.trim().toLowerCase() ?? "";
    return `office:${ext}:${created}|${creator}`;
  } catch {
    return null;
  }
}

/** A photo: when it was taken, to the sub-second, and with which camera. Edited copies keep it. */
export async function photoDocKey(bytes: Uint8Array): Promise<string | null> {
  try {
    const exifr = (await import("exifr")).default;
    const x = await exifr.parse(Buffer.from(bytes), { pick: ["DateTimeOriginal", "SubSecTimeOriginal", "Make", "Model", "BodySerialNumber", "ImageUniqueID"], reviveValues: false }) as Record<string, unknown> | undefined;
    if (!x) return null;
    if (typeof x.ImageUniqueID === "string" && x.ImageUniqueID.trim().length >= 8) return `photo:uid:${x.ImageUniqueID.trim().toLowerCase()}`;
    const when = typeof x.DateTimeOriginal === "string" ? x.DateTimeOriginal : null;
    const sub = x.SubSecTimeOriginal != null ? String(x.SubSecTimeOriginal) : "";
    // Without sub-seconds two photos from a burst would look like one; only then is the moment specific enough.
    if (!when || !sub) return null;
    const camera = [x.Make, x.Model, x.BodySerialNumber].filter((s) => typeof s === "string" && s.trim()).join(" ").toLowerCase();
    return `photo:${when}.${sub}|${camera}`;
  } catch {
    return null;
  }
}

export async function docKeyOf(f: { bytes: Uint8Array; kind: string; ext: string }): Promise<string | null> {
  if (f.kind === "pdf") return pdfDocKey(f.bytes);
  if (f.kind === "docx" || f.kind === "pptx" || (f.kind === "spreadsheet" && f.ext !== "csv" && f.ext !== "xls")) return officeDocKey(f.bytes, f.ext);
  if (f.kind === "image") return photoDocKey(f.bytes);
  return null;
}

/* ── nameKey ─────────────────────────────────────────────────────────────────────────────────────────── */

// Words people add to a file name for another version of the same thing (English and Danish).
const VERSION_WORDS = /[\s._-]*(?:\(\d+\)|copy(?:\s*\d+)?|kopi(?:\s*\d+)?|final|endelig|færdig|faerdig|draft|udkast|updated|opdateret|ny|new|rev(?:ision)?[\s._-]*\d*|v(?:ersion)?[\s._-]*\d+(?:\.\d+)*)$/i;
// Names cameras, scanners and apps give everything: two files called this are not the same document.
const GENERIC = /^(?:img|image|dsc|dscn|pxl|photo|foto|billede|scan|scanned|document|dokument|untitled|unavngivet|unnamed|file|fil|screenshot|skærmbillede|whatsapp image|download|attachment|vedhæftning)?[\s._-]*\d*$/i;

/** The file name as a person thinks of it ("Lejekontrakt v3 (1).pdf" → "lejekontrakt.pdf"), or null if generic. */
export function nameKeyOf(filename: string, kind: string): string | null {
  if (kind === "image" || kind === "audio" || kind === "email") return null; // camera and recorder names repeat everywhere
  const base = (filename.split(/[\\/]/).pop() ?? "").normalize("NFC");
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
  let stem = (dot > 0 ? base.slice(0, dot) : base).toLowerCase().trim();
  for (let i = 0; i < 5; i++) {
    const next = stem.replace(VERSION_WORDS, "").trim();
    if (next === stem) break;
    stem = next;
  }
  stem = stem.replace(/[\s._-]+/g, " ").trim();
  if (stem.length < 3 || GENERIC.test(stem)) return null;
  return `${stem}.${ext}`;
}

/* ── contentKey and similarity ───────────────────────────────────────────────────────────────────────── */

export function normaliseText(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

/** A hash of the text, when there is enough of it to mean something (photos without words have none). */
export function contentKeyOf(text: string | null | undefined): string | null {
  const t = normaliseText(text ?? "");
  return t.length >= 40 ? `text:${sha(t)}` : null;
}

function shingles(text: string, n = 5, cap = 50_000): Set<string> {
  const words = normaliseText(text).split(" ").filter(Boolean);
  const out = new Set<string>();
  if (words.length < n) { if (words.length) out.add(words.join(" ")); return out; }
  for (let i = 0; i + n <= words.length && out.size < cap; i++) out.add(words.slice(i, i + n).join(" "));
  return out;
}

/** How alike two texts are, 0–1 (Jaccard over five-word shingles). */
export function textSimilarity(a: string, b: string): number {
  const A = shingles(a), B = shingles(b);
  if (!A.size || !B.size) return 0;
  let both = 0;
  for (const s of A) if (B.has(s)) both++;
  return both / (A.size + B.size - both);
}

/** A name match needs this much shared text to be a version rather than another document with the same name. */
export const NAME_MATCH_SIMILARITY = 0.35;
