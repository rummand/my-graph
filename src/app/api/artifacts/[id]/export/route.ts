import { z } from "zod";
import { exportHtml, exportPptx } from "@/lib/artifacts/export";
import { apiRoute, errorJson, parseId } from "@/lib/artifacts/http";
import { publicOrigin } from "@/lib/graphs/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

const query = z.object({ format: z.enum(["html", "pptx"]).default("html"), fonts: z.enum(["design", "standard"]).default("design") });

/** GET ?format=html: one self-contained HTML file. ?format=pptx[&fonts=standard]: a PowerPoint file (in the design's fonts, or Arial/Georgia). (PDF: the print page.) */
export const GET = apiRoute<Ctx>(async (req, v, ctx) => {
  const id = parseId((await ctx.params).id);
  const q = query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!q.success) return errorJson(400, "Use format=html or format=pptx, and fonts=design or fonts=standard.");
  const disposition = (filename: string) => `attachment; filename="${filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
  if (q.data.format === "pptx") {
    const { filename, bytes } = await exportPptx(v, id, publicOrigin(req), { fonts: q.data.fonts });
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "Content-Disposition": disposition(filename),
        "Content-Length": String(bytes.byteLength),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
  const { filename, html } = await exportHtml(v, id, publicOrigin(req));
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Disposition": disposition(filename),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
