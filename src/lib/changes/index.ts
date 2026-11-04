/**
 * CONTRACT: the graph works like a git repo (docs/versioning-plan.md). Owned by the versioning workstream; signatures
 * are fixed, bodies are stubs until it lands. Everything is scoped to the viewer's current graph.
 *
 * Every proposal from an agent (chat, live highlights, web research, connectors, ingest, the meta model) is a change set
 * of ops. Nothing touches the graph until a person delivers it. Delivering applies the ops inside the history recorder,
 * so every field that moves is in `graph_events` with who, when and why.
 */
import type { Viewer } from "@/lib/auth";

export type ChangeOp =
  | { op: "addNode"; nodeId?: string; type: string; kind?: string | null; label: string; summary?: string; props?: Record<string, unknown>; aliases?: string[]; startAt?: string | null; endAt?: string | null; visibility?: "private" | "parents" | "household" }
  | { op: "updateNode"; nodeId: string; set: Record<string, unknown> }
  | { op: "retireNode"; nodeId: string }
  | { op: "mergeNodes"; keepId: string; dropId: string }
  | { op: "addEdge"; edgeId?: string; fromId: string; toId: string; relation: string; confidence?: number; status?: "confirmed" | "unconfirmed" | "inferred" }
  | { op: "updateEdge"; edgeId: string; set: Record<string, unknown> }
  | { op: "removeEdge"; edgeId: string }
  | { op: "addKind"; nodeType: string; key: string; label: string; pluralLabel?: string; parentKey?: string | null; description?: string }
  | { op: "addRelationType"; key: string; label: string; inverseLabel: string; fromTypes?: string[]; toTypes?: string[]; symmetric?: boolean; category?: string }
  | { op: "addAttribute"; nodeType: string; kindKey?: string | null; key: string; label: string; type: string }
  | { op: "addReminder"; title: string; dueAt: string; aboutNodeId?: string | null; detail?: string }
  | { op: "editWiki"; slug: string; title?: string; markdown: string };

/** Evidence for one op: where it came from. */
export type Receipt = {
  sourceId?: string; chunkId?: string; locator?: Record<string, unknown>; quote?: string; url?: string;
  conversationId?: string; messageId?: string; runId?: string; confidence?: number;
};

export type ChangeInput = ChangeOp & { note?: string; receipt?: Receipt };

export type ChangeSetOrigin = "person" | "assistant" | "chat" | "connector" | "web" | "ingest" | "automation" | "heartbeat" | "keeper" | "restore";

export type ChangeSetView = {
  id: string; title: string; description: string | null; status: "draft" | "delivered" | "abandoned"; origin: ChangeSetOrigin;
  createdAt: Date; deliveredAt: Date | null; createdByName: string | null;
  changes: { id: string; seq: number; op: string; summary: string; note: string | null; receipt: Receipt; included: boolean; nodeId: string | null; edgeId: string | null; payload: Record<string, unknown> }[];
  /** Per-op verdict against the graph now: outstanding | landed | conflicted. */
  verdicts: Record<string, "outstanding" | "landed" | "conflicted">;
};

/** Opens a change set with its ops (node ids for new nodes are minted here). Returns the id, or null if not allowed. */
export async function proposeChanges(_v: Viewer, _input: { title: string; description?: string; origin: ChangeSetOrigin; evidence?: Receipt; forUserId?: string; changes: ChangeInput[] }): Promise<{ id: string; nodeIds: Record<number, string> } | null> {
  return null;
}

/**
 * Applies a change set (all included ops, or only `onlyChangeIds`) in one transaction, recording history and provenance.
 * The person delivering must be allowed to write; ops that conflict are refused, not half-applied.
 */
export async function deliverChangeSet(_v: Viewer, _id: string, _opts: { onlyChangeIds?: string[]; fingerprint?: string } = {}): Promise<{ ok: boolean; applied: number; conflicts: string[]; error?: string }> {
  return { ok: false, applied: 0, conflicts: [], error: "Versioning is not available yet." };
}

export async function abandonChangeSet(_v: Viewer, _id: string): Promise<boolean> {
  return false;
}

export async function getChangeSet(_v: Viewer, _id: string): Promise<ChangeSetView | null> {
  return null;
}

export async function listChangeSets(_v: Viewer, _opts: { status?: "draft" | "delivered" | "abandoned" | "all"; origin?: ChangeSetOrigin; limit?: number } = {}): Promise<ChangeSetView[]> {
  return [];
}

/**
 * Runs a write to the live graph (nodes, edges, meta, wiki) inside the history recorder: snapshot, write, diff, record
 * one `graph_events` row per field that moved. Existing gbrain writes should go through this.
 */
export async function remembering<T>(_v: Viewer | null, _ctx: { actorKind: "person" | "assistant" | "connector" | "import" | "system"; actorName?: string; changeSetId?: string; context?: string }, write: () => Promise<T>): Promise<T> {
  return write();
}

export type HistoryEvent = {
  id: string; subjectType: string; subjectId: string; subjectName: string | null; kind: string; field: string | null;
  fromValue: unknown; toValue: unknown; actorKind: string; actorName: string | null; changeSetId: string | null; context: string | null; at: Date;
};

export async function historyOf(_v: Viewer, _opts: { subjectId?: string; since?: Date; until?: Date; limit?: number } = {}): Promise<HistoryEvent[]> {
  return [];
}
