import { NextResponse } from "next/server";
import { getGraph } from "@/lib/graphs";
import { parseJson, route, setGraphCookie, switchBody } from "@/lib/graphs/http";

/** POST { graphId }: work in another graph I'm a member of (sets the mg_graph cookie). */
export const POST = route(async (req, v) => {
  const { graphId } = await parseJson(req, switchBody);
  const graph = await getGraph(v, graphId); // 404 unless I'm a member
  return setGraphCookie(NextResponse.json({ graph: { ...graph, isCurrent: true } }), graph.id);
});
