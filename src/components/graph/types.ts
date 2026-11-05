/** The slim, JSON-safe graph shape the graph view works with. */
export type GraphNodeData = { id: string; type: string; label: string; summary: string | null; aliases: string[]; kindLabel?: string | null };
export type GraphEdgeData = {
  id: string; from: string; to: string; relation: string; status: string; confidence: number;
  /** Read from → to ("parent of") and to → from ("child of"), from the household's meta model. */
  label?: string; inverseLabel?: string;
};
export type GraphData = { nodes: GraphNodeData[]; edges: GraphEdgeData[] };

/** Filter and list order on the graph view. */
export const NODE_TYPES = ["person", "organization", "project", "place", "event", "topic", "thing", "commitment", "document", "source"] as const;
