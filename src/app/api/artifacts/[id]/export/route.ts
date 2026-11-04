import { z } from "zod";
import { exportHtml } from "@/lib/artifacts/export";
import { apiRoute, errorJson, parseId } from "@/lib/artifacts/http";
import { publicOrigin } from "@/lib/graphs/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

const query = z.object({ format: z.enum(["html", "pptx"]).default("html") });

/** GET ?format=html: the document as one self-contained HTML file. (PDF: the print page; PowerPoint: later.) */
export const GET = apiRoute<Ctx>(async (req, v, ctx) => {
  const id = parseId((await ctx.params).id);
  const q = query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!q.success) return errorJson(400, "Pick html.");
  if (q.data.format === "pptx") return errorJson(501, "PowerPoint export isn't available yet. Use Print to save a PDF.");
  const { filename, html } = await exportHtml(v, id, publicOrigin(req));
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
