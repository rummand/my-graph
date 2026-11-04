import { archiveGraph, getGraph, updateGraph } from "@/lib/graphs";
import { parseJson, requireKindAllowed, parseParam, route, updateGraphBody, uuid } from "@/lib/graphs/http";

type Ctx = { params: Promise<{ id: string }> };
const NOT_FOUND = "That graph doesn't exist, or you're not in it.";

/** GET: one of my graphs. */
export const GET = route(async (_req, v, ctx: Ctx) => {
  const id = parseParam((await ctx.params).id, uuid, NOT_FOUND);
  return { graph: await getGraph(v, id) };
});

/** PATCH { name?, description?, kind?, color? }: owner only. */
export const PATCH = route(async (req, v, ctx: Ctx) => {
  const id = parseParam((await ctx.params).id, uuid, NOT_FOUND);
  const body = await parseJson(req, updateGraphBody);
  await requireKindAllowed(v, body.kind);
  return { graph: await updateGraph(v, id, body) };
});

/** DELETE: archive the graph (owner only). Not the family graph, and not your last graph. */
export const DELETE = route(async (_req, v, ctx: Ctx) => {
  const id = parseParam((await ctx.params).id, uuid, NOT_FOUND);
  await archiveGraph(v, id);
  return { ok: true };
});
