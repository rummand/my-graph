import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { z } from "zod";
import { requireUserApi } from "@/lib/auth";
import { mediaPath, mediaType, parseRange } from "@/lib/docs/media";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const params = z.object({ file: z.string().min(1).max(120) });

/**
 * GET /api/docs/media/:file: one of the documentation's media files (the film, its poster, captions, chapters, the
 * guides' screenshots) for any signed-in member, children and guests too. Only allow-listed names; Range requests
 * for seeking in the film.
 */
async function serve(req: Request, ctx: { params: Promise<{ file: string }> }, head: boolean): Promise<Response> {
  try {
    await requireUserApi();
  } catch (res) {
    if (res instanceof Response) return res;
    throw res;
  }
  const parsed = params.safeParse(await ctx.params);
  const full = parsed.success ? mediaPath(parsed.data.file) : null;
  if (!parsed.success || !full) return Response.json({ error: "There's no such file in the documentation." }, { status: 404 });
  const st = await stat(full).catch(() => null);
  if (!st?.isFile()) return Response.json({ error: "This file hasn't been published to this server yet." }, { status: 404 });

  const etag = `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
  const headers: Record<string, string> = {
    "Content-Type": mediaType(parsed.data.file),
    "Cache-Control": "private, max-age=3600",
    "Accept-Ranges": "bytes",
    "Last-Modified": st.mtime.toUTCString(),
    ETag: etag,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
  };
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });

  const range = parseRange(req.headers.get("range"), st.size);
  if (range === "unsatisfiable") {
    return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${st.size}` } });
  }
  const { start, end } = range ?? { start: 0, end: st.size - 1 };
  const length = st.size === 0 ? 0 : end - start + 1;
  const out = { ...headers, "Content-Length": String(length) } as Record<string, string>;
  if (range) out["Content-Range"] = `bytes ${start}-${end}/${st.size}`;
  const status = range ? 206 : 200;
  if (head || length === 0) return new Response(null, { status, headers: out });
  const body = Readable.toWeb(createReadStream(full, { start, end })) as ReadableStream<Uint8Array>;
  return new Response(body, { status, headers: out });
}

export function GET(req: Request, ctx: { params: Promise<{ file: string }> }) {
  return serve(req, ctx, false);
}

export function HEAD(req: Request, ctx: { params: Promise<{ file: string }> }) {
  return serve(req, ctx, true);
}
