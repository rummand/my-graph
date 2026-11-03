/**
 * GBrain contract (owned by the GBrain workstream). Server-only.
 * My Graph's own brain — one per login — stored in Postgres (nodes, edges, sources, chunks, provenance).
 * EVERY read takes a Viewer and returns only what that viewer may see (see schema.ts visibility rules).
 * EVERY write records provenance; a node/edge without provenance is a bug.
 */
import type { Viewer } from "@/lib/auth";
import type { Locator } from "@/db/schema";

export type NodeType = "person" | "place" | "event" | "topic" | "document" | "source";
export type Visibility = "private" | "parents" | "household";
export type EdgeStatus = "confirmed" | "unconfirmed" | "inferred" | "rejected" | "superseded";

export type ProvenanceInput = {
  sourceId?: string | null;
  chunkId?: string | null;
  locator?: Locator;
  quote?: string | null;
  activity: "upload" | "ocr" | "transcription" | "llm_extraction" | "manual_edit" | "inference" | "import";
  agentType: "user" | "model" | "rule";
  agentId: string;
  confidence?: number;
  note?: string;
};

export type GNode = {
  id: string; ownerId: string; type: NodeType; label: string; aliases: string[]; summary: string | null;
  props: Record<string, unknown>; startAt: Date | null; endAt: Date | null; timePrecision: "minute" | "day" | "month" | "year" | null;
  visibility: Visibility; sensitive: boolean; createdAt: Date; updatedAt: Date;
};

export type GEdge = {
  id: string; ownerId: string; fromId: string; toId: string; relation: string; props: Record<string, unknown>;
  validFrom: Date | null; validTo: Date | null; confidence: number; status: EdgeStatus; visibility: Visibility; createdAt: Date;
};

export type GProvenance = {
  id: string; sourceId: string | null; sourceTitle: string | null; locator: Locator; quote: string | null;
  activity: ProvenanceInput["activity"]; agentType: ProvenanceInput["agentType"]; agentId: string; confidence: number; note: string | null; createdAt: Date;
};

export type NodeInput = {
  type: NodeType; label: string; aliases?: string[]; summary?: string; props?: Record<string, unknown>;
  startAt?: Date | null; endAt?: Date | null; timePrecision?: GNode["timePrecision"];
  visibility?: Visibility; sensitive?: boolean;
};

export type EdgeInput = {
  fromId: string; toId: string; relation: string; props?: Record<string, unknown>;
  validFrom?: Date | null; validTo?: Date | null; confidence?: number; status?: EdgeStatus; visibility?: Visibility;
};

export type SearchHit = {
  kind: "node" | "chunk"; score: number;
  node?: GNode;
  chunk?: { id: string; sourceId: string; sourceTitle: string; text: string; locator: Locator };
};

/** Create a node (or return the existing one when entity resolution finds a match of the same type). */
export async function upsertNode(v: Viewer, input: NodeInput, prov: ProvenanceInput): Promise<{ node: GNode; created: boolean }> { throw new Error("gbrain.upsertNode not implemented"); }
export async function updateNode(v: Viewer, id: string, patch: Partial<NodeInput>, prov: ProvenanceInput): Promise<GNode> { throw new Error("gbrain.updateNode not implemented"); }
export async function getNode(v: Viewer, id: string): Promise<GNode | null> { throw new Error("gbrain.getNode not implemented"); }
export async function listNodes(v: Viewer, opts?: { type?: NodeType; q?: string; limit?: number }): Promise<GNode[]> { throw new Error("gbrain.listNodes not implemented"); }

/** Assert a fact. Same (from, relation, to) already present → adds provenance and raises confidence instead of duplicating. */
export async function addEdge(v: Viewer, input: EdgeInput, prov: ProvenanceInput): Promise<GEdge> { throw new Error("gbrain.addEdge not implemented"); }
/** Confirm / reject / correct a fact; the user's action is recorded as provenance (agentType "user", activity "manual_edit"). */
export async function setEdgeStatus(v: Viewer, id: string, status: EdgeStatus, note?: string): Promise<GEdge> { throw new Error("gbrain.setEdgeStatus not implemented"); }

/** A node with its edges (both directions) and neighbour nodes, all filtered for the viewer. */
export async function neighbourhood(v: Viewer, id: string, depth?: 1 | 2): Promise<{ nodes: GNode[]; edges: GEdge[] }> { throw new Error("gbrain.neighbourhood not implemented"); }
/** Why do we believe this? Every provenance row for a node or edge, newest first, with source titles. */
export async function explain(v: Viewer, subject: { type: "node" | "edge"; id: string }): Promise<GProvenance[]> { throw new Error("gbrain.explain not implemented"); }

/** Hybrid search (Postgres full-text + pgvector cosine, fused by RRF) over nodes and source chunks the viewer may see. */
export async function search(v: Viewer, query: string, opts?: { limit?: number; types?: NodeType[] }): Promise<SearchHit[]> { throw new Error("gbrain.search not implemented"); }

/** Events (nodes with startAt) in a window, for the timeline. `personIds` filters to events involving those people. */
export async function timeline(v: Viewer, opts: { from?: Date; to?: Date; personIds?: string[]; topicIds?: string[]; limit?: number }): Promise<{ events: GNode[]; involves: { eventId: string; personId: string }[] }> { throw new Error("gbrain.timeline not implemented"); }

/** The whole visible graph (capped), for the graph view. */
export async function graph(v: Viewer, opts?: { limit?: number; centerId?: string }): Promise<{ nodes: GNode[]; edges: GEdge[] }> { throw new Error("gbrain.graph not implemented"); }

/** Merge `dropId` into `keepId` (user-approved entity resolution). Edges and provenance move; the dropped node keeps mergedInto. */
export async function mergeNodes(v: Viewer, keepId: string, dropId: string): Promise<GNode> { throw new Error("gbrain.mergeNodes not implemented"); }
/** Pairs that look like the same entity, for the user to approve. */
export async function mergeSuggestions(v: Viewer, limit?: number): Promise<{ a: GNode; b: GNode; reason: string; score: number }[]> { throw new Error("gbrain.mergeSuggestions not implemented"); }

/** Whether the viewer may read / edit a node (ownership, visibility, role, shares, guest expiry). */
export async function canRead(v: Viewer, node: Pick<GNode, "ownerId" | "visibility"> & { id: string }): Promise<boolean> { throw new Error("gbrain.canRead not implemented"); }
export async function canEdit(v: Viewer, node: Pick<GNode, "ownerId"> & { id: string }): Promise<boolean> { throw new Error("gbrain.canEdit not implemented"); }
