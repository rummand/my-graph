/** The slim, JSON-safe graph shape the graph view works with. */
export type GraphNodeData = { id: string; type: string; label: string; summary: string | null; aliases: string[] };
export type GraphEdgeData = { id: string; from: string; to: string; relation: string; status: string; confidence: number };
export type GraphData = { nodes: GraphNodeData[]; edges: GraphEdgeData[] };

export const NODE_TYPES = ["person", "place", "event", "topic", "document", "source"] as const;
