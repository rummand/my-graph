import { z } from "zod";
import { isoDate, query, route } from "@/lib/changes/http";
import { compare } from "@/lib/history/read";

const q = z.object({ from: isoDate, to: isoDate });

/** GET /api/history/compare?from=&to= → what changed between two moments (things added, gone and changed). */
export const GET = route(async (req, v) => {
  const { from, to } = query(req, q);
  const d = await compare(v, from, to);
  const n = (x: { id: string; label: string; type: string }) => ({ id: x.id, label: x.label, type: x.type });
  return {
    nodesAdded: d.nodesAdded.map(n), nodesRemoved: d.nodesRemoved.map(n),
    nodesChanged: d.nodesChanged.map((c) => ({ ...n(c.after), fields: c.fields })),
    edgesAdded: d.edgesAdded.map((e) => ({ id: e.id, fromId: e.fromId, toId: e.toId, relation: e.relation })),
    edgesRemoved: d.edgesRemoved.map((e) => ({ id: e.id, fromId: e.fromId, toId: e.toId, relation: e.relation })),
    edgesChanged: d.edgesChanged.map((c) => ({ id: c.after.id, fromId: c.after.fromId, toId: c.after.toId, relation: c.after.relation, fields: c.fields })),
  };
});
