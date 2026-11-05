/**
 * Backup encryption: AES-256-GCM with a key derived from BACKUP_KEY by scrypt. Server-only, no database.
 *
 * File format ("MGBK", version 1), byte by byte:
 *   0..3    "MGBK"
 *   4       1 (version)
 *   5..20   salt (16 bytes, random per file or per run): key = scrypt(BACKUP_KEY, salt, 32, N=2^15, r=8, p=1)
 *   21..32  IV (12 bytes, random per file)
 *   33..n-17 ciphertext
 *   last 16 GCM authentication tag
 * A wrong key or a changed byte anywhere fails the tag check; nothing decrypted is trusted until it passes.
 * The header (magic, version, salt, IV) is bound to the ciphertext as additional authenticated data.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync, createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { Readable, Transform } from "node:stream";

export const MAGIC = Buffer.from("MGBK", "ascii");
export const VERSION = 1;
export const SALT_BYTES = 16;
export const IV_BYTES = 12;
export const TAG_BYTES = 16;
export const HEADER_BYTES = MAGIC.length + 1 + SALT_BYTES + IV_BYTES; // 33
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 96 * 1024 * 1024 } as const;

/** Development-only key, used when BACKUP_KEY is unset outside production (the admin page says so). */
export const DEV_KEY = "my-graph-development-backup-key-not-for-production";

export class BackupCryptoError extends Error {
  constructor(message: string) { super(message); this.name = "BackupCryptoError"; }
}

const keyCache = new Map<string, Buffer>();

/** The 32-byte AES key for a secret and salt (cached: deriving takes ~100 ms on purpose). */
export function deriveKey(secret: string, salt: Buffer): Buffer {
  if (!secret) throw new BackupCryptoError("No backup key.");
  const id = createHash("sha256").update(secret).update(salt).digest("hex");
  const hit = keyCache.get(id);
  if (hit) return hit;
  const k = scryptSync(secret, salt, 32, SCRYPT);
  if (keyCache.size > 64) keyCache.clear();
  keyCache.set(id, k);
  return k;
}

export function newSalt(): Buffer {
  return randomBytes(SALT_BYTES);
}

function header(salt: Buffer, iv: Buffer): Buffer {
  return Buffer.concat([MAGIC, Buffer.from([VERSION]), salt, iv]);
}

export function parseHeader(h: Buffer): { salt: Buffer; iv: Buffer } {
  if (h.length < HEADER_BYTES || !h.subarray(0, 4).equals(MAGIC)) throw new BackupCryptoError("This isn't a My Graph backup file.");
  if (h[4] !== VERSION) throw new BackupCryptoError(`Unsupported backup file version ${h[4]}.`);
  return { salt: h.subarray(5, 5 + SALT_BYTES), iv: h.subarray(5 + SALT_BYTES, HEADER_BYTES) };
}

/** Encrypt a whole buffer (small files: manifests). */
export function encryptBuffer(plain: Buffer, secret: string, salt: Buffer = newSalt()): Buffer {
  const iv = randomBytes(IV_BYTES);
  const h = header(salt, iv);
  const c = createCipheriv("aes-256-gcm", deriveKey(secret, salt), iv);
  c.setAAD(h);
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([h, body, c.getAuthTag()]);
}

/** Decrypt a whole buffer; throws BackupCryptoError on a wrong key or a damaged file. */
export function decryptBuffer(file: Buffer, secret: string): Buffer {
  if (file.length < HEADER_BYTES + TAG_BYTES) throw new BackupCryptoError("The backup file is too short to be complete.");
  const h = file.subarray(0, HEADER_BYTES);
  const { salt, iv } = parseHeader(h);
  const d = createDecipheriv("aes-256-gcm", deriveKey(secret, salt), iv);
  d.setAAD(h);
  d.setAuthTag(file.subarray(file.length - TAG_BYTES));
  try {
    return Buffer.concat([d.update(file.subarray(HEADER_BYTES, file.length - TAG_BYTES)), d.final()]);
  } catch {
    throw new BackupCryptoError("The backup couldn't be decrypted: the key is wrong or the file is damaged.");
  }
}

/** A Transform that writes the header, the ciphertext and finally the tag. */
export function encryptStream(secret: string, salt: Buffer = newSalt()): Transform {
  const iv = randomBytes(IV_BYTES);
  const h = header(salt, iv);
  const c = createCipheriv("aes-256-gcm", deriveKey(secret, salt), iv);
  c.setAAD(h);
  let started = false;
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      if (!started) { started = true; this.push(h); }
      const out = c.update(chunk);
      if (out.length) this.push(out);
      cb();
    },
    flush(cb) {
      if (!started) this.push(h);
      const out = c.final();
      if (out.length) this.push(out);
      this.push(c.getAuthTag());
      cb();
    },
  });
}

/**
 * Decrypting stream of an encrypted file on disk. The stream errors at its end if the tag doesn't match, so callers
 * that act on the plaintext must first run `verifyFile` (restore does).
 */
export async function decryptFileStream(path: string, secret: string): Promise<Readable> {
  const fh = await open(path, "r");
  let salt: Buffer, iv: Buffer, tag: Buffer, h: Buffer, size: number;
  try {
    size = (await fh.stat()).size;
    if (size < HEADER_BYTES + TAG_BYTES) throw new BackupCryptoError("The backup file is too short to be complete.");
    h = Buffer.alloc(HEADER_BYTES);
    await fh.read(h, 0, HEADER_BYTES, 0);
    ({ salt, iv } = parseHeader(h));
    tag = Buffer.alloc(TAG_BYTES);
    await fh.read(tag, 0, TAG_BYTES, size - TAG_BYTES);
  } finally {
    await fh.close();
  }
  const d = createDecipheriv("aes-256-gcm", deriveKey(secret, salt), iv);
  d.setAAD(h);
  d.setAuthTag(tag);
  if (size === HEADER_BYTES + TAG_BYTES) {
    // Empty plaintext: createReadStream can't express an empty range, so finish the decipher directly.
    try { d.final(); } catch { throw new BackupCryptoError("The backup couldn't be decrypted: the key is wrong or the file is damaged."); }
    return Readable.from([]);
  }
  const src = createReadStream(path, { start: HEADER_BYTES, end: size - TAG_BYTES - 1 });
  const out = new Transform({
    transform(chunk: Buffer, _e, cb) { cb(null, d.update(chunk)); },
    flush(cb) {
      try { const f = d.final(); if (f.length) this.push(f); cb(); }
      catch { cb(new BackupCryptoError("The backup couldn't be decrypted: the key is wrong or the file is damaged.")); }
    },
  });
  src.on("error", (e) => out.destroy(e));
  return src.pipe(out);
}

/** Decrypt the whole file without keeping the plaintext: true when the key is right and the file is intact. */
export async function verifyFile(path: string, secret: string): Promise<void> {
  const s = await decryptFileStream(path, secret);
  await new Promise<void>((resolve, reject) => {
    s.on("data", () => {});
    s.on("end", () => resolve());
    s.on("error", reject);
  });
}

/** How good BACKUP_KEY is: unset, too short to accept (< 16 characters), or fine. */
export function keyStrength(secret: string | undefined | null): "missing" | "weak" | "ok" {
  const s = (secret ?? "").trim();
  if (!s) return "missing";
  return s.length < 16 ? "weak" : "ok";
}
