import { requireUser } from "@/lib/auth";
import { mergeNodes } from "@/lib/gbrain";
import { handle, idParam, json, readJson } from "@/lib/gbrain/http";
import { mergeSchema } from "@/lib/gbrain/schemas";

/** POST /api/nodes/[id]/merge { dropId } — fold `dropId` into this node. */
export function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const v = await requireUser();
    const { id } = idParam.parse(await ctx.params);
    const { dropId } = mergeSchema.parse(await readJson(req));
    return json({ node: await mergeNodes(v, id, dropId) });
  });
}
