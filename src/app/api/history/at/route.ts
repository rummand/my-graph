import { z } from "zod";
import { isoDate, query, route } from "@/lib/changes/http";
import { graphAt, historyStartsAt, liveOnly } from "@/lib/history/read";

const q = z.object({ date: isoDate });

/** GET /api/history/at?date= → { at, startsAt, nodes, edges } — the graph as the viewer would have seen it then. */
export const GET = route(async (req, v) => {
  const { date } = query(req, q);
  const [state, startsAt] = await Promise.all([graphAt(v, date), historyStartsAt(v)]);
  const live = liveOnly(state);
  return {
    at: date, startsAt,
    nodes: [...live.nodes.values()].map((n) => ({ id: n.id, type: n.type, kind: n.kind, label: n.label, summary: n.summary, startAt: n.startAt, endAt: n.endAt })),
    edges: [...live.edges.values()].map((e) => ({ id: e.id, fromId: e.fromId, toId: e.toId, relation: e.relation, status: e.status, confidence: e.confidence })),
  };
});
