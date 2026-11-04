import { NextResponse } from "next/server";
import { createGraph, listGraphs } from "@/lib/graphs";
import { setGraphCookie } from "@/lib/graphs/http";
import { requireClinical } from "@/lib/clinical";
import { route } from "@/lib/clinical/http";

export const dynamic = "force-dynamic";

/** POST: open my practice graph (made the first time), and work in it. Only for accounts with a practice plan. */
export const POST = route(async (_req, v) => {
  await requireClinical(v, { practice: false });
  const have = (await listGraphs(v)).find((g) => g.kind === "practice" && !g.archivedAt);
  const graph = have ?? await createGraph(v, { name: "Practice", kind: "practice" });
  return setGraphCookie(NextResponse.json({ graph: { id: graph.id, name: graph.name } }, { status: have ? 200 : 201 }), graph.id);
});
