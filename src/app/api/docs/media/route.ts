import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { z } from "zod";
import { mediaDir, mediaPath, tokenMatches } from "@/lib/docs/media";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Bigger than the film will ever be; a runaway upload stops here. */
const MAX_BYTES = 1024 * 1024 * 1024;

const query = z.object({ name: z.string().min(1).max(120) });

/**
 * POST /api/docs/media?name=<file>: publish one documentation file (ops/video/my-graph/publish.mjs). The body is the
 * file's bytes. Needs `Authorization: Bearer <DOCS_UPLOAD_TOKEN>` (compared in constant time) and an allow-listed
 * name. Written to a temporary file and renamed into place, so a half-sent upload never replaces a good file.
 */
export async function POST(req: Request) {
  if (!tokenMatches(req.headers.get("authorization"), process.env.DOCS_UPLOAD_TOKEN)) {
    return Response.json({ error: "Uploading documentation needs the upload token." }, { status: 401 });
  }
  const q = query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  const dest = q.success ? mediaPath(q.data.name) : null;
  if (!q.success || !dest) return Response.json({ error: "That file name isn't one the documentation uses." }, { status: 400 });
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_BYTES) return Response.json({ error: "That file is too big." }, { status: 413 });
  if (!req.body) return Response.json({ error: "The upload was empty." }, { status: 400 });

  const dir = mediaDir();
  await mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.upload-${randomUUID()}`);
  let seen = 0;
  try {
    const src = Readable.fromWeb(req.body as unknown as NodeReadableStream<Uint8Array>);
    src.on("data", (c: Buffer) => {
      seen += c.length;
      if (seen > MAX_BYTES) src.destroy(new Error("too big"));
    });
    await pipeline(src, createWriteStream(tmp));
    if (seen === 0) throw new Error("empty");
    await rename(tmp, dest);
  } catch (e) {
    await rm(tmp, { force: true });
    const msg = e instanceof Error && e.message === "too big" ? "That file is too big." : "The upload didn't finish. Try again.";
    return Response.json({ error: msg }, { status: e instanceof Error && e.message === "too big" ? 413 : 400 });
  }
  const st = await stat(dest);
  return Response.json({ ok: true, name: q.data.name, size: st.size });
}
