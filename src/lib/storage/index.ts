/**
 * Content-addressed file storage for originals. Server-only. Files live under UPLOAD_DIR (default ./data/uploads) at
 * <sha256[0:2]>/<sha256>, written once and never modified. The same bytes uploaded twice are stored once.
 */
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

export function uploadDir(): string {
  return path.resolve(process.env.UPLOAD_DIR || "./data/uploads");
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** "ab/abcdef…" for a sha256 hex digest. */
export function storageKeyFor(sha256: string): string {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error("Invalid sha256");
  return `${sha256.slice(0, 2)}/${sha256}`;
}

/** Absolute path for a storage key, refusing anything that would escape UPLOAD_DIR. */
export function pathFor(key: string): string {
  if (!/^[0-9a-f]{2}\/[0-9a-f]{64}$/.test(key)) throw new Error("Invalid storage key");
  return path.join(uploadDir(), key);
}

/** Store bytes (idempotent). */
export async function putFile(bytes: Uint8Array): Promise<{ sha256: string; storageKey: string; size: number; existed: boolean }> {
  const sha256 = sha256Hex(bytes);
  const storageKey = storageKeyFor(sha256);
  const full = pathFor(storageKey);
  try {
    const s = await stat(full);
    if (s.size === bytes.byteLength) return { sha256, storageKey, size: bytes.byteLength, existed: true };
  } catch { /* not there yet */ }
  await mkdir(path.dirname(full), { recursive: true });
  const tmp = `${full}.${randomUUID()}.tmp`;
  await writeFile(tmp, bytes, { mode: 0o640 });
  await rename(tmp, full); // atomic on the same filesystem
  return { sha256, storageKey, size: bytes.byteLength, existed: false };
}

export async function readStored(key: string): Promise<Buffer> {
  return readFile(pathFor(key));
}

export async function statStored(key: string): Promise<{ size: number } | null> {
  try {
    const s = await stat(pathFor(key));
    return { size: s.size };
  } catch {
    return null;
  }
}

/** A web ReadableStream of the file, optionally a byte range (inclusive end). */
export function streamStored(key: string, range?: { start: number; end: number }): ReadableStream<Uint8Array> {
  const node = createReadStream(pathFor(key), range ? { start: range.start, end: range.end } : undefined);
  return Readable.toWeb(node) as unknown as ReadableStream<Uint8Array>;
}

export async function deleteStored(key: string): Promise<void> {
  try {
    await unlink(pathFor(key));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}
