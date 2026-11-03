import { createGraph, listGraphs } from "@/lib/graphs";
import { createGraphBody, parseJson, route } from "@/lib/graphs/http";

/** GET: the graphs I'm in (with my role and how many people are in each) and which one I'm working in. */
export const GET = route(async (_req, v) => ({ graphs: await listGraphs(v), currentGraphId: v.graphId }));

/** POST { name, description?, kind?, color? }: make a new graph that I own. */
export const POST = route(async (req, v) => {
  const body = await parseJson(req, createGraphBody);
  const graph = await createGraph(v, body);
  return Response.json({ graph }, { status: 201 });
});
