import { z } from "zod";
import { transferGraph, transferHousehold } from "@/lib/export";
import { parseJson, route, uuid } from "@/lib/export/http";

const body = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("household"), to: uuid }),
  z.object({ kind: z.literal("graph"), graphId: uuid, to: uuid }),
]);

/**
 * POST { kind: "household", to } | { kind: "graph", graphId, to } → { ok }. Hand the household (to a parent in it)
 * or a graph you own (to one of its members) to someone else, e.g. before deleting your account. You stay in it as
 * a parent / editor.
 */
export const POST = route(async (req, v) => {
  const input = await parseJson(req, body);
  if (input.kind === "household") await transferHousehold(v.id, input.to);
  else await transferGraph(v.id, input.graphId, input.to);
  return Response.json({ ok: true });
});
