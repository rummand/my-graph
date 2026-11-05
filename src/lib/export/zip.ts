/**
 * Writing an export to a zip file on disk (server-only). JSON is compressed; originals are stored as they are
 * (photos and PDFs don't shrink) and streamed from storage, so a large library never sits in memory at once.
 */
import { createReadStream, createWriteStream } from "node:fs";
import { rename, rm, stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";
import { Transform } from "node:stream";
import JSZip from "jszip";
import type { Entry, Manifest } from "./format";

export type ZipResult = { bytes: number; sha256: string; missingFiles: string[] };

/** Write `entries` (+ manifest.json) to `dest`. `fileFor` maps a storage key to its path on disk. */
export async function writeZip(entries: Entry[], manifest: Manifest, dest: string, fileFor: (storageKey: string) => string): Promise<ZipResult> {
  const zip = new JSZip();
  const missingFiles: string[] = [];
  for (const e of entries) {
    if (e.kind === "json") zip.file(e.path, `${JSON.stringify(e.data, null, 2)}\n`, { compression: "DEFLATE" });
    else if (e.kind === "text") zip.file(e.path, e.text, { compression: "DEFLATE" });
    else {
      const p = fileFor(e.file.storageKey);
      let ok = false;
      try { ok = (await stat(p)).isFile(); } catch { ok = false; }
      if (!ok) { missingFiles.push(e.path); continue; }
      zip.file(e.path, createReadStream(p), { compression: "STORE", binary: true });
    }
  }
  zip.file("manifest.json", `${JSON.stringify({ ...manifest, missingFiles }, null, 2)}\n`, { compression: "DEFLATE" });

  const h = createHash("sha256");
  let bytes = 0;
  const tap = new Transform({ transform(c: Buffer, _e, cb) { h.update(c); bytes += c.length; cb(null, c); } });
  const tmp = `${dest}.partial`;
  try {
    await pipeline(zip.generateNodeStream({ type: "nodebuffer", streamFiles: true }), tap, createWriteStream(tmp, { mode: 0o600 }));
    await rename(tmp, dest);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
  return { bytes, sha256: h.digest("hex"), missingFiles };
}
