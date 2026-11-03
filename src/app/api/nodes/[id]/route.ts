import { requireUser } from "@/lib/auth";
import { GBrainError, updateNode } from "@/lib/gbrain";
import { loadNodeDetail } from "@/lib/gbrain/detail";
import { handle, idParam, json, readJson } from "@/lib/gbrain/http";
import { nodePatchSchema } from "@/lib/gbrain/schemas";

/** GET /api/nodes/[id] — node, neighbourhood, provenance (node + each fact), merge suggestions. */
export function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const v = await requireUser();
    const { id } = idParam.parse(await ctx.params);
    const detail = await loadNodeDetail(v, id);
    if (!detail) throw new GBrainError(404, "That item doesn't exist or isn't shared with you.");
    return json(detail);
  });
}

/** PATCH /api/nodes/[id] — edit a node; recorded as a manual edit by the viewer. */
export function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const v = await requireUser();
    const { id } = idParam.parse(await ctx.params);
    const { note, ...patch } = nodePatchSchema.parse(await readJson(req));
    const node = await updateNode(v, id, patch, {
      activity: "manual_edit", agentType: "user", agentId: v.id, confidence: 1, note: note || "Edited by hand",
    });
    return json({ node });
  });
}
