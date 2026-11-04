// Publish the documentation's media (the film, poster, captions, chapters and the guides' screenshots) to a running My
// Graph through POST /api/docs/media. Big files don't go in git; the server keeps them in DOCS_MEDIA_DIR (default
// <UPLOAD_DIR>/docs, on Railway the volume at /data).
//
//   DOCS_UPLOAD_TOKEN=… node ops/video/my-graph/publish.mjs https://web-production-1858e.up.railway.app
//   DOCS_UPLOAD_TOKEN=… node ops/video/my-graph/publish.mjs http://localhost:3917 my-graph-explained.vtt   # just one file
//
// The server needs the same DOCS_UPLOAD_TOKEN in its environment (16 characters or more). Only the allow-listed names
// in src/lib/docs/film.ts are accepted; run guides.mjs first so build/docs/ has them.
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DOCS = path.join(HERE, "build", "docs");
const [base, ...only] = process.argv.slice(2);
const token = process.env.DOCS_UPLOAD_TOKEN;
if (!base || !/^https?:\/\//.test(base)) { console.error("usage: DOCS_UPLOAD_TOKEN=… node publish.mjs <server url> [file …]"); process.exit(2); }
if (!token) { console.error("Set DOCS_UPLOAD_TOKEN (the same value as on the server)."); process.exit(2); }
if (!fs.existsSync(DOCS)) { console.error(`Nothing to publish: run node ops/video/my-graph/guides.mjs first (${DOCS}).`); process.exit(2); }

// Small files first, the film last, so the pages work as soon as possible.
const files = (only.length ? only : fs.readdirSync(DOCS)).filter((f) => !f.startsWith("."))
  .sort((a, b) => fs.statSync(path.join(DOCS, a)).size - fs.statSync(path.join(DOCS, b)).size);
let failed = 0;
for (const f of files) {
  const full = path.join(DOCS, f);
  const size = fs.statSync(full).size;
  const t0 = Date.now();
  const res = await fetch(new URL(`/api/docs/media?name=${encodeURIComponent(f)}`, base), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream", "content-length": String(size) },
    body: Readable.toWeb(fs.createReadStream(full)),
    duplex: "half",
  }).catch((e) => ({ ok: false, status: 0, text: async () => e.message }));
  const body = await res.text();
  if (!res.ok) failed++;
  console.log(`${res.ok ? "ok  " : "FAIL"} ${f.padEnd(44)} ${(size / 1e6).toFixed(1).padStart(6)} MB  ${((Date.now() - t0) / 1000).toFixed(1)}s${res.ok ? "" : `  ${res.status} ${body.slice(0, 200)}`}`);
}
process.exit(failed ? 1 : 0);
