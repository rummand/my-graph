import { NextResponse } from "next/server";
import { z } from "zod";
import { withViewer } from "@/lib/ingest/http";
import { deleteFolder, updateFolder } from "@/lib/ingest/folders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };
const idParam = z.object({ id: z.string().uuid("That isn't a valid folder.") });

const patchBody = z.object({
  name: z.string().min(1, "Give the folder a name.").max(200, "Keep the name under 80 characters.").optional(),
  /** null: to the top level. */
  parentId: z.string().uuid("That isn't a valid folder.").nullable().optional(),
  visibility: z.enum(["private", "parents", "household"]).optional(),
}).strict();

/** PATCH /api/library/folders/:id — rename, move ({ parentId }) or change who sees it. */
export async function PATCH(req: Request, ctx: Ctx) {
  return withViewer(async (v) => {
    const { id } = idParam.parse(await ctx.params);
    await updateFolder(v, id, patchBody.parse(await req.json().catch(() => ({}))));
    return NextResponse.json({ ok: true });
  });
}

/** DELETE /api/library/folders/:id — the folder goes; its files and subfolders move up to its parent. */
export async function DELETE(_req: Request, ctx: Ctx) {
  return withViewer(async (v) => {
    const { id } = idParam.parse(await ctx.params);
    return NextResponse.json({ ok: true, ...(await deleteFolder(v, id)) });
  });
}
