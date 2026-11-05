import { NextResponse } from "next/server";
import { z } from "zod";
import { withViewer } from "@/lib/ingest/http";
import { applyTemplate, deleteTemplate, listTemplates, saveTemplate } from "@/lib/ingest/folders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/library/folders/templates — built-in templates (this graph's kind first) and the ones people saved. */
export async function GET() {
  return withViewer(async (v) => NextResponse.json({ templates: await listTemplates(v) }));
}

const body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("apply"), templateId: z.string().min(1).max(100), visibility: z.enum(["private", "parents", "household"]).optional() }).strict(),
  z.object({ action: z.literal("save"), name: z.string().min(1, "Give the template a name.").max(200), scope: z.enum(["graph", "household"]) }).strict(),
  z.object({ action: z.literal("delete"), templateId: z.string().uuid() }).strict(),
]);

/**
 * POST /api/library/folders/templates
 *   { action: "apply", templateId, visibility? } → { created } (only missing folders are made)
 *   { action: "save", name, scope }              → 201 { id } (the folders you see, as a template)
 *   { action: "delete", templateId }             → { ok } (your own saved templates)
 */
export async function POST(req: Request) {
  return withViewer(async (v) => {
    const b = body.parse(await req.json().catch(() => ({})));
    if (b.action === "apply") return NextResponse.json(await applyTemplate(v, b.templateId, b.visibility));
    if (b.action === "save") return NextResponse.json(await saveTemplate(v, { name: b.name, scope: b.scope }), { status: 201 });
    await deleteTemplate(v, b.templateId);
    return NextResponse.json({ ok: true });
  });
}
