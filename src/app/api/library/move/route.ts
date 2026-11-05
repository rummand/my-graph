import { NextResponse } from "next/server";
import { z } from "zod";
import { withViewer } from "@/lib/ingest/http";
import { moveFiles } from "@/lib/ingest/folders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const body = z.object({
  sourceIds: z.array(z.string().uuid("That isn't a valid file.")).min(1, "Choose at least one file.").max(500, "Move at most 500 files at a time."),
  /** null: out of every folder. */
  folderId: z.string().uuid("That isn't a valid folder.").nullable(),
}).strict();

/** POST /api/library/move — { sourceIds, folderId | null }: every version of each file moves; files you can't change are skipped. */
export async function POST(req: Request) {
  return withViewer(async (v) => {
    const b = body.parse(await req.json().catch(() => ({})));
    return NextResponse.json(await moveFiles(v, b.sourceIds, b.folderId));
  });
}
