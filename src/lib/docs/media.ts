/**
 * The documentation's media files (the film, its poster, captions, chapters and the guides' screenshots). Big files
 * don't go in git: they live in DOCS_MEDIA_DIR (default <UPLOAD_DIR>/docs, on the Railway volume at /data) and are
 * served by /api/docs/media/[file] and uploaded by ops/video/my-graph/publish.mjs through POST /api/docs/media.
 *
 * Pure helpers (no Next, no DB) so the allow-list, Range parsing and the token check are tested on their own.
 */
import { timingSafeEqual, createHash } from "node:crypto";
import path from "node:path";
import { FILM_FILES, SHOT_FILES } from "./film";

/** Every file name the media route will serve or accept. Nothing else, ever: no paths, no patterns. */
export const MEDIA_FILES: ReadonlySet<string> = new Set([...FILM_FILES, ...SHOT_FILES]);

export function isAllowedMedia(name: unknown): name is string {
  return typeof name === "string" && MEDIA_FILES.has(name);
}

const TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".vtt": "text/vtt; charset=utf-8",
  ".srt": "application/x-subrip; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

export function mediaType(name: string): string {
  return TYPES[path.extname(name).toLowerCase()] ?? "application/octet-stream";
}

/** Where the files live: DOCS_MEDIA_DIR, else <UPLOAD_DIR>/docs, else ./data/uploads/docs. */
export function mediaDir(env: Record<string, string | undefined> = process.env): string {
  if (env.DOCS_MEDIA_DIR) return path.resolve(env.DOCS_MEDIA_DIR);
  return path.join(path.resolve(env.UPLOAD_DIR || "./data/uploads"), "docs");
}

/** The file's absolute path, or null when the name isn't on the allow-list. */
export function mediaPath(name: string, dir = mediaDir()): string | null {
  return isAllowedMedia(name) ? path.join(dir, name) : null;
}

export type ByteRange = { start: number; end: number };

/**
 * One byte range from a Range header, for a file of `size` bytes.
 * - null: no usable Range header (send the whole file, 200)
 * - "unsatisfiable": a range that starts past the end (416)
 * - { start, end }: inclusive byte offsets (206)
 * Multiple ranges ("bytes=0-1,5-9") aren't supported and fall back to the whole file, which RFC 9110 allows.
 */
export function parseRange(header: string | null | undefined, size: number): ByteRange | "unsatisfiable" | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  if (size <= 0) return "unsatisfiable";
  if (m[1] === "") {
    // suffix: the last N bytes
    const n = Number(m[2]);
    if (!Number.isSafeInteger(n) || n <= 0) return "unsatisfiable";
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  if (!Number.isSafeInteger(start) || start >= size) return "unsatisfiable";
  let end = m[2] === "" ? size - 1 : Number(m[2]);
  if (!Number.isSafeInteger(end)) end = size - 1;
  if (end < start) return null;
  return { start, end: Math.min(end, size - 1) };
}

/**
 * Does an Authorization header carry the upload token? "Bearer <token>", compared in constant time (both sides hashed
 * first so their lengths match). No token configured means uploads are off.
 */
export function tokenMatches(authorization: string | null | undefined, secret: string | null | undefined): boolean {
  if (!secret || secret.length < 16) return false;
  const m = /^Bearer\s+(.+)$/i.exec(authorization?.trim() ?? "");
  if (!m) return false;
  const a = createHash("sha256").update(m[1].trim()).digest();
  const b = createHash("sha256").update(secret).digest();
  return timingSafeEqual(a, b);
}
