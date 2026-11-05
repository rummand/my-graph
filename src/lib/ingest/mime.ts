/**
 * File type detection for uploads. Pure: decides from the file name, the browser's declared type and the first bytes
 * (magic numbers), so a renamed executable never gets through as a "pdf".
 */
import { importerForFile } from "@/lib/importers/registry";

export type FileKind = "pdf" | "docx" | "pptx" | "spreadsheet" | "text" | "image" | "audio" | "email" | "mailbox" | "archive" | "import";
export type FileCategory = "pdf" | "document" | "slides" | "spreadsheet" | "text" | "image" | "audio" | "email" | "mailbox" | "other";

/** Containers are split into messages (each its own source); they are not read as one document. */
export const CONTAINER_KINDS: ReadonlySet<FileKind> = new Set(["mailbox", "archive"]);
export const MBOX_MIME = "application/mbox";
export const ZIP_MIME = "application/zip";
export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const XLS_MIME = "application/vnd.ms-excel";
export const ODS_MIME = "application/vnd.oasis.opendocument.spreadsheet";
export const CSV_MIME = "text/csv";
const SPREADSHEET_MIMES = new Set([XLSX_MIME, XLS_MIME, ODS_MIME, CSV_MIME, "application/vnd.ms-excel.sheet.macroenabled.12"]);

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

export type DetectResult =
  | { ok: true; mime: string; kind: FileKind; ext: string; /** Set when an importer (src/lib/importers) reads it. */ importer?: string }
  | { ok: false; reason: string };

/** Plain-English list of what the library accepts, for error messages and the upload zone. */
export const ACCEPTED_DESCRIPTION = "PDF, Word (.docx), PowerPoint (.pptx), spreadsheets (.xlsx, .xls, .ods, .csv), text (.txt, .md), email (.eml, a mailbox .mbox, or a .zip of .eml files), photos (JPG, PNG, HEIC, WebP), audio (MP3, M4A, WAV, OGG, WebM), and exports: family trees (.ged), contacts (.vcf), location history (Google Takeout .json or .zip), WhatsApp chats (.txt or .zip), Messenger and Instagram chats (.json or the .zip), Obsidian vaults and Notion exports (.zip)";

/** The `accept` attribute for the file picker. */
export const ACCEPT_ATTR = [
  ".pdf", ".docx", ".pptx", ".xlsx", ".xlsm", ".xls", ".ods", ".txt", ".md", ".markdown", ".csv", ".eml", ".mbox", ".zip", ".json", ".ged", ".vcf",
  ".jpg", ".jpeg", ".png", ".heic", ".heif", ".webp",
  ".mp3", ".m4a", ".wav", ".ogg", ".oga", ".opus", ".webm",
  "application/pdf", "image/*", "audio/*", "text/plain", "text/markdown", "text/csv", "message/rfc822", "application/mbox", "application/zip",
  DOCX_MIME, PPTX_MIME, XLSX_MIME, XLS_MIME, ODS_MIME,
].join(",");

const TEXT_EXT: Record<string, string> = { txt: "text/plain", md: "text/markdown", markdown: "text/markdown" };
const AUDIO_EXT: Record<string, string> = { mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/ogg", webm: "audio/webm" };
const IMAGE_EXT: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", heic: "image/heic", heif: "image/heic", webp: "image/webp" };

export function extensionOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

function startsWith(head: Uint8Array, bytes: number[], offset = 0): boolean {
  if (head.length < offset + bytes.length) return false;
  return bytes.every((b, i) => head[offset + i] === b);
}

function ascii(head: Uint8Array, from: number, to: number): string {
  return String.fromCharCode(...head.slice(from, Math.min(to, head.length)));
}

/** Text files must not contain NUL bytes and must decode as UTF-8 (ignoring a multi-byte char cut at the end). */
export function looksLikeText(head: Uint8Array): boolean {
  if (head.includes(0)) return false;
  try {
    // Drop up to 3 trailing bytes in case the sample cut a multi-byte character in half.
    const sample = head.length > 3 ? head.slice(0, head.length - 3) : head;
    new TextDecoder("utf-8", { fatal: true }).decode(sample);
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect the type of an upload.
 * @param name   original file name
 * @param declaredMime the browser-supplied type (may be empty or wrong)
 * @param head   at least the first 64 bytes (the more the better for text checks; 8 KB is plenty)
 */
export function detectFileType(name: string, declaredMime: string, head: Uint8Array): DetectResult {
  const ext = extensionOf(name);
  const declared = (declaredMime || "").toLowerCase().split(";")[0].trim();
  if (head.length === 0) return { ok: false, reason: `"${name}" is empty.` };

  // Structured files an importer reads without a model (.ged, .vcf, a chat export …). Zips are matched later, from
  // their file names, when the archive is opened.
  if (!startsWith(head, [0x50, 0x4b, 0x03, 0x04])) {
    const imp = importerForFile(name, head);
    if (imp) return { ok: true, mime: imp.mime, kind: "import", ext, importer: imp.id };
  }

  // Binary formats — trust the bytes.
  if (startsWith(head, [0x25, 0x50, 0x44, 0x46, 0x2d])) return { ok: true, mime: "application/pdf", kind: "pdf", ext: "pdf" };
  if (startsWith(head, [0xff, 0xd8, 0xff])) return { ok: true, mime: "image/jpeg", kind: "image", ext: "jpg" };
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { ok: true, mime: "image/png", kind: "image", ext: "png" };
  if (ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 12) === "WEBP") return { ok: true, mime: "image/webp", kind: "image", ext: "webp" };
  if (ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 12) === "WAVE") return { ok: true, mime: "audio/wav", kind: "audio", ext: "wav" };
  if (ascii(head, 0, 4) === "OggS") return { ok: true, mime: "audio/ogg", kind: "audio", ext: "ogg" };
  if (startsWith(head, [0x1a, 0x45, 0xdf, 0xa3])) {
    // Matroska/WebM. We only accept it as audio (voice memos recorded in the browser).
    if (declared.startsWith("video/") ) return { ok: false, reason: `"${name}" is a video. The library takes audio recordings, not video.` };
    return { ok: true, mime: "audio/webm", kind: "audio", ext: "webm" };
  }
  if (ascii(head, 0, 3) === "ID3" || (head[0] === 0xff && head.length > 1 && (head[1] & 0xe0) === 0xe0 && (head[1] & 0x06) !== 0)) {
    return { ok: true, mime: "audio/mpeg", kind: "audio", ext: "mp3" };
  }
  if (ascii(head, 4, 8) === "ftyp") {
    const brand = ascii(head, 8, 12).toLowerCase();
    if (["heic", "heix", "heim", "heis", "hevc", "hevx", "mif1", "msf1", "heif"].includes(brand)) return { ok: true, mime: "image/heic", kind: "image", ext: "heic" };
    if (brand.startsWith("m4a") || brand === "m4b " || ext === "m4a" || declared.startsWith("audio/")) return { ok: true, mime: "audio/mp4", kind: "audio", ext: "m4a" };
    return { ok: false, reason: `"${name}" looks like a video. The library takes audio recordings, not video.` };
  }
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04])) {
    // Office files are zips; the extension or declared type says which, else the part names near the start do.
    const names = ascii(head, 0, head.length);
    if (ext === "docx" || declared === DOCX_MIME) return { ok: true, mime: DOCX_MIME, kind: "docx", ext: "docx" };
    if (ext === "pptx" || declared === PPTX_MIME) return { ok: true, mime: PPTX_MIME, kind: "pptx", ext: "pptx" };
    if (ext === "xlsx" || ext === "xlsm" || declared === XLSX_MIME) return { ok: true, mime: XLSX_MIME, kind: "spreadsheet", ext: "xlsx" };
    if (ext === "ods" || declared === ODS_MIME || names.includes(ODS_MIME)) return { ok: true, mime: ODS_MIME, kind: "spreadsheet", ext: "ods" };
    if (["odp", "odt", "ppsx", "potx"].includes(ext)) return { ok: false, reason: `"${name}" isn't a format the library reads. Save it as PDF${ext === "odt" ? " or .docx" : " or .pptx"} and upload that.` };
    if (ext === "zip" || declared === "application/zip" || declared === "application/x-zip-compressed") return { ok: true, mime: ZIP_MIME, kind: "archive", ext: "zip" };
    if (names.includes("ppt/")) return { ok: true, mime: PPTX_MIME, kind: "pptx", ext: "pptx" };
    if (names.includes("xl/")) return { ok: true, mime: XLSX_MIME, kind: "spreadsheet", ext: "xlsx" };
    if (names.includes("word/")) return { ok: true, mime: DOCX_MIME, kind: "docx", ext: "docx" };
    return { ok: false, reason: `"${name}" is a zip archive. Name it .zip to import the emails inside, or unpack it and upload the files.` };
  }
  if (startsWith(head, [0xd0, 0xcf, 0x11, 0xe0])) {
    // Old binary Office files. Excel 97–2003 (.xls) can be read; old PowerPoint and Word can't.
    if (ext === "xls" || declared === XLS_MIME) return { ok: true, mime: XLS_MIME, kind: "spreadsheet", ext: "xls" };
    if (ext === "ppt" || ext === "pps" || declared === "application/vnd.ms-powerpoint") {
      return { ok: false, reason: `"${name}" is an old PowerPoint file (.ppt), which the library can't read. Open it in PowerPoint or Keynote, save it as .pptx and upload that.` };
    }
    return { ok: false, reason: `"${name}" is an old Word/Office file (.doc). Save it as .docx or PDF and upload that.` };
  }

  // Text formats — decided by extension (or declared type), then checked to really be text.
  const isText = looksLikeText(head);
  if (ext === "mbox" || declared === "application/mbox") {
    return isText ? { ok: true, mime: MBOX_MIME, kind: "mailbox", ext: "mbox" } : { ok: false, reason: `"${name}" doesn't look like a mailbox file.` };
  }
  if (ext === "eml" || declared === "message/rfc822") {
    return isText ? { ok: true, mime: "message/rfc822", kind: "email", ext: "eml" } : { ok: false, reason: `"${name}" doesn't look like an email file.` };
  }
  if (ext === "csv" || declared === CSV_MIME) {
    return isText ? { ok: true, mime: CSV_MIME, kind: "spreadsheet", ext: "csv" } : { ok: false, reason: `"${name}" isn't readable text.` };
  }
  const textMime = TEXT_EXT[ext] ?? (["text/plain", "text/markdown"].includes(declared) ? declared : undefined);
  if (textMime) {
    return isText ? { ok: true, mime: textMime, kind: "text", ext: ext || textMime.split("/")[1] } : { ok: false, reason: `"${name}" isn't readable text.` };
  }

  if (ext === "ppt") return { ok: false, reason: `"${name}" is an old PowerPoint file (.ppt), which the library can't read. Open it in PowerPoint or Keynote, save it as .pptx and upload that.` };
  if (IMAGE_EXT[ext] || AUDIO_EXT[ext] || ["pdf", "docx", "pptx", "xlsx", "xls", "ods"].includes(ext)) {
    return { ok: false, reason: `"${name}" says it is a .${ext} file, but its contents don't match. It may be damaged.` };
  }
  return { ok: false, reason: `"${name}" isn't a file type the library can read. Accepted: ${ACCEPTED_DESCRIPTION}.` };
}

/** Group a mime type into what people recognise (for icons and filters). */
export function mimeCategory(mime: string | null | undefined): FileCategory {
  const m = (mime ?? "").toLowerCase();
  if (m === "application/pdf") return "pdf";
  if (m.includes("wordprocessingml")) return "document";
  if (m.includes("presentationml")) return "slides";
  if (SPREADSHEET_MIMES.has(m)) return "spreadsheet";
  if (m === "message/rfc822") return "email";
  if (m === MBOX_MIME || m === ZIP_MIME) return "mailbox";
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("audio/")) return "audio";
  if (m.startsWith("text/")) return "text";
  return "other";
}

export const CATEGORY_LABEL: Record<FileCategory, string> = {
  pdf: "PDF", document: "Word document", slides: "Presentation", spreadsheet: "Spreadsheet", text: "Text", image: "Photo", audio: "Audio", email: "Email", mailbox: "Mail import", other: "Note",
};

/** The processing kind for a stored mime type (inverse of detectFileType's result). */
export function kindFromMime(mime: string | null | undefined): FileKind | null {
  const m = (mime ?? "").toLowerCase();
  if (m === "application/pdf") return "pdf";
  if (m.includes("wordprocessingml")) return "docx";
  if (m.includes("presentationml")) return "pptx";
  if (SPREADSHEET_MIMES.has(m)) return "spreadsheet";
  if (m === "message/rfc822") return "email";
  if (m === MBOX_MIME) return "mailbox";
  if (m === ZIP_MIME) return "archive";
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("audio/")) return "audio";
  if (m.startsWith("text/")) return "text";
  return null;
}
