import { requireUser } from "@/lib/auth";
import { correctEdge, setEdgeStatus } from "@/lib/gbrain";
import { handle, idParam, json, readJson } from "@/lib/gbrain/http";
import { edgePatchSchema } from "@/lib/gbrain/schemas";

/** PATCH /api/graph/edges/[id] — { action: "confirm" | "reject" | "correct", note?, relation?, fromId?, toId? } */
export function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const v = await requireUser();
    const { id } = idParam.parse(await ctx.params);
    const body = edgePatchSchema.parse(await readJson(req));
    if (body.action === "correct") {
      const edge = await correctEdge(v, id, { relation: body.relation, fromId: body.fromId, toId: body.toId, note: body.note });
      return json({ edge, replaced: id });
    }
    const edge = await setEdgeStatus(v, id, body.action === "confirm" ? "confirmed" : "rejected", body.note);
    return json({ edge });
  });
}
