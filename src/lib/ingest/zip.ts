/**
 * A small zip reader for mail exports (a .zip of .eml files). Reads the central directory, supports stored and
 * deflated entries, skips folders, macOS resource forks and anything encrypted. Bounded: at most `maxEntries`
 * entries and `maxTotalBytes` uncompressed, so a zip bomb stops early instead of filling memory.
 */
import { inflateRawSync } from "node:zlib";

export type ZipEntry = { name: string; bytes: Uint8Array };

export class ZipError extends Error {}

const SIG_EOCD = 0x06054b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;

export function readZip(buf: Uint8Array, opts: { maxEntries?: number; maxTotalBytes?: number; accept?: (name: string) => boolean } = {}): ZipEntry[] {
  const maxEntries = opts.maxEntries ?? 2000;
  const maxTotal = opts.maxTotalBytes ?? 200 * 1024 * 1024;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // End of central directory: scan back over a possible comment (max 65535 bytes).
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (dv.getUint32(i, true) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new ZipError("This doesn't look like a zip file.");
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  if (count === 0xffff || p === 0xffffffff) throw new ZipError("Zip64 archives aren't supported. Zip fewer files at a time.");

  const out: ZipEntry[] = [];
  let total = 0;
  const dec = new TextDecoder("utf-8");
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || dv.getUint32(p, true) !== SIG_CEN) throw new ZipError("The zip file is damaged.");
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const usize = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith("/") || name.startsWith("__MACOSX/") || name.split("/").pop()!.startsWith("._")) continue;
    if (flags & 1) continue; // encrypted
    if (opts.accept && !opts.accept(name)) continue;
    if (out.length >= maxEntries) throw new ZipError(`The zip has more than ${maxEntries} files. Split it into smaller zips.`);
    total += usize;
    if (total > maxTotal) throw new ZipError("The zip unpacks to more than we can read at once. Split it into smaller zips.");

    if (local + 30 > buf.length || dv.getUint32(local, true) !== SIG_LOC) throw new ZipError("The zip file is damaged.");
    const lNameLen = dv.getUint16(local + 26, true);
    const lExtraLen = dv.getUint16(local + 28, true);
    const start = local + 30 + lNameLen + lExtraLen;
    const data = buf.subarray(start, start + csize);
    let bytes: Uint8Array;
    if (method === 0) bytes = data;
    else if (method === 8) bytes = new Uint8Array(inflateRawSync(data, { maxOutputLength: Math.max(1, usize) }));
    else continue; // other compression methods: skip
    out.push({ name, bytes });
  }
  return out;
}
