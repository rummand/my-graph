import { NextResponse } from "next/server";
import { z } from "zod";
import { withViewer } from "@/lib/ingest/http";
import { acceptSuggestions, dismissSuggestions, listSuggestions, runSuggestions } from "@/lib/ingest/folders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** GET /api/library/folders/suggestions — your files not in a folder that have a suggested folder, grouped by folder. */
export async function GET() {
  return withViewer(async (v) => NextResponse.json({ groups: await listSuggestions(v) }));
}

const ids = z.array(z.string().uuid("That isn't a valid file.")).min(1).max(500);
const body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("run") }).strict(),
  z.object({ action: z.literal("accept"), sourceIds: z.union([ids, z.literal("all")]) }).strict(),
  z.object({ action: z.literal("dismiss"), sourceIds: ids }).strict(),
]);

/**
 * POST /api/library/folders/suggestions
 *   { action: "run" }                       → suggest folders for your unfiled files (rules, then the model when mux is up)
 *   { action: "accept", sourceIds | "all" } → make the missing folders and move the files (as you)
 *   { action: "dismiss", sourceIds }        → no suggestion, and that folder isn't suggested for the file again
 * Every answer includes the groups as they are now.
 */
export async function POST(req: Request) {
  return withViewer(async (v) => {
    const b = body.parse(await req.json().catch(() => ({})));
    const result = b.action === "run" ? await runSuggestions(v)
      : b.action === "accept" ? await acceptSuggestions(v, b.sourceIds)
      : await dismissSuggestions(v, b.sourceIds);
    return NextResponse.json({ ...result, groups: await listSuggestions(v) });
  });
}
