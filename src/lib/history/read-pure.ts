/** Restoring a moment, pure: the ops that would make the graph look as it did then. */
import type { ChangeInput } from "@/lib/changes";
import { diffStates, type GraphState } from "./pure";

const RESTORABLE_NODE_FIELDS = new Set(["label", "summary", "aliases", "kind", "type", "startAt", "endAt", "visibility", "sensitive"]);

/**
 * The ops that would make the graph look as it did then (pure over two states). Only the viewer's own things are
 * touched — a restore never changes someone else's item — and merges are not undone (noted, skipped).
 */
export function restoreOps(now: GraphState, then: GraphState, me: string, note = "Back to how it was then"): { ops: ChangeInput[]; skipped: number } {
  const d = diffStates(now, then);
  const ops: ChangeInput[] = [];
  let skipped = 0;
  for (const n of d.nodesAdded) {
    const cur = now.nodes.get(n.id);
    if (cur && cur.ownerId === me && cur.props.retired === true && !cur.mergedInto) ops.push({ op: "updateNode", nodeId: n.id, set: { props: { retired: null, retiredAt: null } }, note });
    else skipped++;
  }
  for (const n of d.nodesRemoved) {
    if (n.ownerId === me) ops.push({ op: "retireNode", nodeId: n.id, note }); else skipped++;
  }
  for (const c of d.nodesChanged) {
    if (c.after.ownerId !== me) { skipped++; continue; }
    const set: Record<string, unknown> = {};
    const props: Record<string, unknown> = {};
    for (const f of c.fields) {
      if (f.field.startsWith("props.")) props[f.field.slice(6)] = f.to ?? null;
      else if (RESTORABLE_NODE_FIELDS.has(f.field)) set[f.field] = f.to ?? null;
    }
    if (Object.keys(props).length) set.props = props;
    if (Object.keys(set).length) ops.push({ op: "updateNode", nodeId: c.after.id, set, note }); else skipped++;
  }
  for (const e of d.edgesAdded) {
    const cur = now.edges.get(e.id);
    if (e.ownerId !== me) { skipped++; continue; }
    if (cur) ops.push({ op: "updateEdge", edgeId: e.id, set: { status: e.status }, note });
    else ops.push({ op: "addEdge", fromId: e.fromId, toId: e.toId, relation: e.relation, status: e.status === "confirmed" || e.status === "inferred" ? e.status : "unconfirmed", confidence: e.confidence, note });
  }
  for (const e of d.edgesRemoved) {
    if (e.ownerId === me) ops.push({ op: "removeEdge", edgeId: e.id, note }); else skipped++;
  }
  for (const c of d.edgesChanged) {
    if (c.after.ownerId !== me) { skipped++; continue; }
    const set: Record<string, unknown> = {};
    for (const f of c.fields) if (["relation", "status", "confidence", "validFrom", "validTo"].includes(f.field)) set[f.field] = f.to;
    if (Object.keys(set).length) ops.push({ op: "updateEdge", edgeId: c.after.id, set, note });
  }
  return { ops, skipped };
}

