/**
 * CONTRACT: the graph works like a git repo (docs/versioning-plan.md). Owned by the versioning workstream; signatures
 * are fixed, bodies are stubs until it lands. Everything is scoped to the viewer's current graph.
 *
 * Every proposal from an agent (chat, live highlights, web research, connectors, ingest, the meta model) is a change set
 * of ops. Nothing touches the graph until a person delivers it. Delivering applies the ops inside the history recorder,
 * so every field that moves is in `graph_events` with who, when and why.
 */
import type { Viewer } from "@/lib/auth";
import { db } from "@/db";
import { currentScope, historyStore, type HistoryScope } from "@/lib/history/context";
import { recordMeta, snapshotMeta } from "@/lib/history/record";
import { abandon, getOne, list, propose } from "./store";
import { deliver } from "./deliver";

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
  /** Hash of the ops as they stand; pass it back on deliver so an approval of an older version is refused. */
  fingerprint?: string | null;
};

/** Opens a change set with its ops (node ids for new nodes are minted here). Returns the id, or null if not allowed. */
export async function proposeChanges(v: Viewer, input: { title: string; description?: string; origin: ChangeSetOrigin; evidence?: Receipt; forUserId?: string; changes: ChangeInput[] }): Promise<{ id: string; nodeIds: Record<number, string> } | null> {
  return propose(v, input);
}

/**
 * Applies a change set (all included ops, or only `onlyChangeIds`) in one transaction, recording history and provenance.
 * The person delivering must be allowed to write; ops that conflict are refused, not half-applied.
 */
export async function deliverChangeSet(v: Viewer, id: string, opts: { onlyChangeIds?: string[]; fingerprint?: string } = {}): Promise<{ ok: boolean; applied: number; conflicts: string[]; error?: string }> {
  return deliver(v, id, opts);
}

export async function abandonChangeSet(v: Viewer, id: string): Promise<boolean> {
  return abandon(v, id);
}

export async function getChangeSet(v: Viewer, id: string): Promise<ChangeSetView | null> {
  return getOne(v, id);
}

export async function listChangeSets(v: Viewer, opts: { status?: "draft" | "delivered" | "abandoned" | "all"; origin?: ChangeSetOrigin; limit?: number } = {}): Promise<ChangeSetView[]> {
  return list(v, opts);
}

/** The signed-in viewer of this request, when a caller (meta admin) has none at hand. */
async function requestViewer(): Promise<Viewer | null> {
  try {
    const { getViewer } = await import("@/lib/auth");
    return await getViewer();
  } catch {
    return null;
  }
}

/**
 * Runs a write to the live graph (nodes, edges, meta, wiki) inside the history recorder: snapshot, write, diff, record
 * one `graph_events` row per field that moved. Existing gbrain writes should go through this.
 *
 * GBrain's own writes record their rows themselves (before/after inside their transaction) and take the hand from
 * here; this wrapper also watches the graph's meta model, so kinds, relation types and attributes have history too.
 * Recording never fails the write.
 */
export async function remembering<T>(v: Viewer | null, ctx: { actorKind: "person" | "assistant" | "connector" | "import" | "system"; actorName?: string; changeSetId?: string; context?: string }, write: () => Promise<T>): Promise<T> {
  const viewer = v ?? (await requestViewer());
  const parent = currentScope();
  const graphId = viewer?.graphId ?? parent?.graphId;
  if (!graphId) return write();
  const scope: HistoryScope = {
    ...parent,
    graphId,
    actor: { kind: ctx.actorKind, id: ctx.actorKind === "person" ? viewer?.id ?? null : null, name: ctx.actorName ?? (ctx.actorKind === "person" ? viewer?.name ?? null : null) },
    changeSetId: ctx.changeSetId ?? parent?.changeSetId ?? null,
    context: ctx.context ?? parent?.context ?? null,
    metaWatched: true,
  };
  const household = viewer?.graphHouseholdId ?? viewer?.householdId;
  const watchMeta = !parent?.metaWatched && !!household;
  let before: Awaited<ReturnType<typeof snapshotMeta>> | null = null;
  if (watchMeta) {
    try { before = await snapshotMeta(db, household!, graphId); } catch (e) { console.error("[history] could not snapshot the model", e); }
  }
  const result = await historyStore.run(scope, write);
  if (before && household) {
    try {
      const after = await snapshotMeta(db, household, graphId);
      await recordMeta(db, graphId, before, after, { actor: scope.actor, changeSetId: scope.changeSetId, context: scope.context });
    } catch (e) {
      console.error("[history] the model write happened but was not recorded", e);
    }
  }
  return result;
}

export type HistoryEvent = {
  id: string; subjectType: string; subjectId: string; subjectName: string | null; kind: string; field: string | null;
  fromValue: unknown; toValue: unknown; actorKind: string; actorName: string | null; changeSetId: string | null; context: string | null; at: Date;
};

export async function historyOf(v: Viewer, opts: { subjectId?: string; since?: Date; until?: Date; limit?: number } = {}): Promise<HistoryEvent[]> {
  const { historyFor } = await import("@/lib/history/read");
  return historyFor(v, opts);
}
