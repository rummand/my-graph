import { z } from "zod";
import { idParam, jsonError, withViewer } from "@/lib/ingest/http";
import { getReadableSource } from "@/lib/ingest/library";
import { statStored, streamStored } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const query = z.object({ download: z.enum(["1", "true"]).optional() });

/** RFC 5987 filename for Content-Disposition. */
function disposition(kind: "inline" | "attachment", name: string) {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/**
 * Types a browser may render inline. Everything else (email, HEIC, markdown/CSV and anything unexpected) is always
 * sent as a download, so a crafted file can never be rendered as a page on our origin.
 */
const INLINE_TYPES = new Set([
  "application/pdf", "image/jpeg", "image/png", "image/webp", "text/plain",
  "audio/mpeg", "audio/mp4", "audio/wav", "audio/ogg", "audio/webm",
]);

/** GET /api/files/:id — the original file, after an access check. Supports Range (audio seeking). */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return withViewer(async (v) => {
    const { id } = idParam.parse(await ctx.params);
    const { download } = query.parse(Object.fromEntries(new URL(req.url).searchParams));
    const src = await getReadableSource(v, id);
    if (!src || !src.storageKey) return jsonError(404, "This file doesn't exist or you don't have access to it.");
    const st = await statStored(src.storageKey);
    if (!st) return jsonError(410, "The original file is missing from storage.");

    const etag = `"${src.sha256}"`;
    const mime = src.mime ?? "application/octet-stream";
    const inline = !download && INLINE_TYPES.has(mime);
    const headers: Record<string, string> = {
      "Content-Type": mime === "text/plain" ? "text/plain; charset=utf-8" : mime,
      "Content-Disposition": disposition(inline ? "inline" : "attachment", src.title),
      "Cache-Control": "private, max-age=3600",
      ETag: etag,
      "Accept-Ranges": "bytes",
      "X-Content-Type-Options": "nosniff",
    };
    // Lock the response down. (Not for PDFs: Chrome's built-in PDF viewer refuses to run in a sandboxed document.)
    if (mime !== "application/pdf") headers["Content-Security-Policy"] = "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox";
    if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });

    const range = req.headers.get("range")?.match(/^bytes=(\d*)-(\d*)$/);
    if (range && (range[1] || range[2])) {
      let start: number, end: number;
      if (range[1] === "") { // suffix range: last N bytes
        start = Math.max(0, st.size - Number(range[2]));
        end = st.size - 1;
      } else {
        start = Number(range[1]);
        end = range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
      }
      if (start > end || start >= st.size) {
        return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${st.size}` } });
      }
      return new Response(streamStored(src.storageKey, { start, end }), {
        status: 206,
        headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${st.size}`, "Content-Length": String(end - start + 1) },
      });
    }
    return new Response(streamStored(src.storageKey), { status: 200, headers: { ...headers, "Content-Length": String(st.size) } });
  });
}
