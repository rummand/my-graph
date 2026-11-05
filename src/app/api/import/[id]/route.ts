import { NextResponse } from "next/server";
import { z } from "zod";
import { IngestError } from "@/lib/ingest";
import { jsonError, withViewer } from "@/lib/ingest/http";
import { importerById } from "@/lib/importers/registry";
import { importPayload } from "@/lib/importers/server";
import { hit } from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 10 * 1024 * 1024;
const params = z.object({ id: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/) });
const envelope = z.object({
  title: z.string().trim().min(1).max(250).optional(),
  visibility: z.enum(["private", "parents", "household"]).optional(),
  data: z.unknown(),
});

/**
 * POST /api/import/<importer> { title?, visibility?, data }: a JSON batch from the iPhone app or the Mac helper
 * (contacts, photo metadata, places, health records …). `data` is checked against the importer's schema, kept as a
 * library source and read by the importer; what it adds becomes a change set to review. Signed-in person, their
 * current graph; rate-limited.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return withViewer(async (v) => {
    const p = params.safeParse(await ctx.params);
    const importer = p.success ? importerById(p.data.id) : null;
    if (!importer?.json) return jsonError(404, "There is no importer with that name.");
    const len = Number(req.headers.get("content-length") ?? 0);
    if (len > MAX_BYTES) return jsonError(413, "That batch is too large. Send at most 10 MB at a time.");
    const rate = await hit("import", v.id);
    if (!rate.allowed) return NextResponse.json({ error: "Too many imports. Wait a few minutes and try again." }, { status: 429, headers: { "Retry-After": String(rate.retryAfterSec) } });
    const text = await req.text();
    if (text.length > MAX_BYTES) return jsonError(413, "That batch is too large. Send at most 10 MB at a time.");
    let body: unknown;
    try { body = JSON.parse(text); } catch { throw new IngestError(400, "The request body isn't valid JSON."); }
    const e = envelope.parse(body);
    const data = importer.json.safeParse(e.data);
    if (!data.success) return jsonError(400, data.error.issues[0]?.message ?? "That batch isn't in the expected shape.", { issues: data.error.issues.slice(0, 5) });
    const r = await importPayload(v, importer.id, {
      bytes: Buffer.from(JSON.stringify(data.data)), title: e.title ?? importer.label, visibility: e.visibility,
    });
    return NextResponse.json(r, { status: r.duplicate ? 200 : 201 });
  });
}
