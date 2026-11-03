/** Everything the node page (and GET /api/nodes/[id]) shows about one node, filtered for the viewer. */
import type { Viewer } from "@/lib/auth";
import {
  agentNames, canEdit, explain, explainEdges, getNode, mergeSuggestionsFor, neighbourhood,
  type GEdge, type GNode, type GProvenance,
} from "./index";

export type NodeDetail = {
  node: GNode;
  /** True when the requested id was merged into `node`. */
  redirectedFrom: string | null;
  neighbours: GNode[];
  edges: GEdge[];
  provenance: { node: GProvenance[]; edges: Record<string, GProvenance[]> };
  agents: Record<string, string>;
  canEdit: boolean;
  mergeSuggestions: { other: GNode; reason: string; score: number }[];
};

export async function loadNodeDetail(v: Viewer, id: string): Promise<NodeDetail | null> {
  const node = await getNode(v, id);
  if (!node) return null;
  const [nb, nodeProv, editable, sugg] = await Promise.all([
    neighbourhood(v, node.id, 1),
    explain(v, { type: "node", id: node.id }),
    canEdit(v, node),
    mergeSuggestionsFor(v, node.id, 5),
  ]);
  const edgeProv = await explainEdges(v, nb.edges.map((e) => e.id));
  const agents = await agentNames(v, [...nodeProv, ...Object.values(edgeProv).flat()]);
  return {
    node,
    redirectedFrom: node.id === id ? null : id,
    neighbours: nb.nodes.filter((n) => n.id !== node.id),
    edges: nb.edges,
    provenance: { node: nodeProv, edges: edgeProv },
    agents,
    canEdit: editable,
    mergeSuggestions: editable ? sugg.map((s) => ({ other: s.b, reason: s.reason, score: s.score })) : [],
  };
}
