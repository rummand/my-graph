import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { readZip, ZipError } from "./zip";

/** Build a minimal zip (stored or deflated entries) for the reader to read back. */
function makeZip(files: { name: string; data: string; deflate?: boolean }[]): Uint8Array {
  const locals: Buffer[] = [], cens: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const raw = Buffer.from(f.data);
    const body = f.deflate ? deflateRawSync(raw) : raw;
    const name = Buffer.from(f.name);
    const loc = Buffer.alloc(30);
    loc.writeUInt32LE(0x04034b50, 0); loc.writeUInt16LE(20, 4); loc.writeUInt16LE(f.deflate ? 8 : 0, 8);
    loc.writeUInt32LE(body.length, 18); loc.writeUInt32LE(raw.length, 22); loc.writeUInt16LE(name.length, 26);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(f.deflate ? 8 : 0, 10);
    cen.writeUInt32LE(body.length, 20); cen.writeUInt32LE(raw.length, 24); cen.writeUInt16LE(name.length, 28); cen.writeUInt32LE(offset, 42);
    locals.push(loc, name, body);
    cens.push(cen, name);
    offset += loc.length + name.length + body.length;
  }
  const cenBuf = Buffer.concat(cens);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cenBuf.length, 12); eocd.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, cenBuf, eocd]));
}

describe("readZip", () => {
  it("reads stored and deflated entries and skips folders and macOS forks", () => {
    const zip = makeZip([
      { name: "mail/", data: "" },
      { name: "mail/a.eml", data: "Subject: a\n\nhello", deflate: true },
      { name: "b.eml", data: "Subject: b\n\nhi" },
      { name: "__MACOSX/._b.eml", data: "junk" },
    ]);
    const out = readZip(zip);
    expect(out.map((e) => e.name)).toEqual(["mail/a.eml", "b.eml"]);
    expect(new TextDecoder().decode(out[0].bytes)).toBe("Subject: a\n\nhello");
  });
  it("filters entries and stops at the limits", () => {
    const zip = makeZip([{ name: "a.eml", data: "x" }, { name: "b.txt", data: "y" }, { name: "c.eml", data: "z" }]);
    expect(readZip(zip, { accept: (n) => n.endsWith(".eml") }).map((e) => e.name)).toEqual(["a.eml", "c.eml"]);
    expect(() => readZip(zip, { maxEntries: 1 })).toThrow(ZipError);
    expect(() => readZip(new Uint8Array([1, 2, 3]))).toThrow(ZipError);
  });
});
