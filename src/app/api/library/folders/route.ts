import { NextResponse } from "next/server";
import { z } from "zod";
import { withViewer } from "@/lib/ingest/http";
import { createFolder, listFolders } from "@/lib/ingest/folders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/library/folders — the folder tree the viewer can see in the current graph, with file counts. */
export async function GET() {
  return withViewer(async (v) => NextResponse.json(await listFolders(v)));
}

const createBody = z.object({
  name: z.string().min(1, "Give the folder a name.").max(200, "Keep the name under 80 characters."),
  parentId: z.string().uuid("That isn't a valid folder.").nullish(),
  visibility: z.enum(["private", "parents", "household"]).optional(),
}).strict();

/** POST /api/library/folders — { name, parentId?, visibility? } → 201 { folder }. */
export async function POST(req: Request) {
  return withViewer(async (v) => {
    const b = createBody.parse(await req.json().catch(() => ({})));
    const folder = await createFolder(v, { name: b.name, parentId: b.parentId ?? null, visibility: b.visibility });
    return NextResponse.json({ folder }, { status: 201 });
  });
}
