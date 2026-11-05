import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { randomBytes } from "node:crypto";
import {
  BackupCryptoError, HEADER_BYTES, TAG_BYTES, decryptBuffer, decryptFileStream, encryptBuffer, encryptStream, keyStrength, newSalt, verifyFile,
} from "./crypto";

const KEY = "correct horse battery staple, but longer";

let dir: string;
beforeAll(async () => { dir = await mkdtemp(path.join(os.tmpdir(), "mg-crypto-")); });
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

async function collect(r: Readable): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const c of r) parts.push(c as Buffer);
  return Buffer.concat(parts);
}

describe("buffer encryption", () => {
  it("round-trips, with a header and a tag around the ciphertext", () => {
    const plain = Buffer.from("Anna's school letter, page 2");
    const enc = encryptBuffer(plain, KEY);
    expect(enc.subarray(0, 4).toString()).toBe("MGBK");
    expect(enc.length).toBe(HEADER_BYTES + plain.length + TAG_BYTES);
    expect(enc.includes(plain)).toBe(false);
    expect(decryptBuffer(enc, KEY).equals(plain)).toBe(true);
  });

  it("uses a fresh IV each time (same input, different output)", () => {
    const salt = newSalt();
    const a = encryptBuffer(Buffer.from("same"), KEY, salt);
    const b = encryptBuffer(Buffer.from("same"), KEY, salt);
    expect(a.equals(b)).toBe(false);
  });

  it("refuses a wrong key", () => {
    const enc = encryptBuffer(Buffer.from("secret"), KEY);
    expect(() => decryptBuffer(enc, "another key that is long enough")).toThrow(BackupCryptoError);
  });

  it("refuses a changed byte in the ciphertext, the header or the tag", () => {
    const enc = encryptBuffer(Buffer.from("the whole family tree"), KEY);
    for (const at of [HEADER_BYTES + 3, 20, enc.length - 1]) {
      const bad = Buffer.from(enc);
      bad[at] ^= 0x01;
      expect(() => decryptBuffer(bad, KEY)).toThrow();
    }
  });

  it("refuses something that isn't a backup file", () => {
    expect(() => decryptBuffer(Buffer.alloc(64), KEY)).toThrow(/isn't a My Graph backup/);
    expect(() => decryptBuffer(Buffer.from("MGBK"), KEY)).toThrow(/too short/);
  });
});

describe("stream encryption", () => {
  it("round-trips a large stream through a file", async () => {
    const plain = randomBytes(3 * 1024 * 1024 + 17);
    const file = path.join(dir, "big.mgbk");
    await pipeline(Readable.from([plain.subarray(0, 1000), plain.subarray(1000)]), encryptStream(KEY), createWriteStream(file));
    await verifyFile(file, KEY);
    const back = await collect(await decryptFileStream(file, KEY));
    expect(back.equals(plain)).toBe(true);
    // A file written by the stream decrypts as a whole buffer too (one format).
    expect(decryptBuffer(await readFile(file), KEY).equals(plain)).toBe(true);
  });

  it("handles an empty stream", async () => {
    const file = path.join(dir, "empty.mgbk");
    await pipeline(Readable.from([]), encryptStream(KEY), createWriteStream(file));
    expect((await readFile(file)).length).toBe(HEADER_BYTES + TAG_BYTES);
    expect((await collect(await decryptFileStream(file, KEY))).length).toBe(0);
  });

  it("fails verification with the wrong key or a damaged file", async () => {
    const file = path.join(dir, "v.mgbk");
    await pipeline(Readable.from([Buffer.from("x".repeat(10_000))]), encryptStream(KEY), createWriteStream(file));
    await expect(verifyFile(file, "the wrong key, long enough")).rejects.toThrow(/key is wrong or the file is damaged/);
    const bytes = await readFile(file);
    bytes[HEADER_BYTES + 500] ^= 0xff;
    await writeFile(file, bytes);
    await expect(verifyFile(file, KEY)).rejects.toThrow();
  });
});

describe("key strength", () => {
  it("needs a key of at least 16 characters", () => {
    expect(keyStrength(undefined)).toBe("missing");
    expect(keyStrength("   ")).toBe("missing");
    expect(keyStrength("short")).toBe("weak");
    expect(keyStrength("a".repeat(16))).toBe("ok");
  });
});
