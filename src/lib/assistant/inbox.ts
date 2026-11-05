/** Conversation inbox actions that need a model (server-only): "Compact this conversation". */
import type { Viewer } from "@/lib/auth";
import { logActivity } from "@/lib/automations";
import * as mux from "@/lib/mux";
import { autoCompactSplit, cleanSummary, compactMessages, compactSplit, fallbackSummary, turnsAfter } from "./compact";
import { foldState } from "./state";
import { conversationRows, ownConversation, saveSummary } from "./store";

export class InboxError extends Error {
  constructor(public status: 404 | 409, message: string) { super(message); }
}

/**
 * Summarise the earlier turns (all but the last few) into conversations.summary. From then on the model gets the
 * summary instead of those turns. Works without mux (a plain list of the questions asked).
 */
export async function compactConversation(v: Viewer, id: string): Promise<{ summary: string; upToMessageId: string; compacted: number; degraded: boolean }> {
  const c = await ownConversation(v, id);
  if (!c) throw new InboxError(404, "That conversation doesn't exist or isn't yours.");
  const rows = await conversationRows(c.id);
  const sensitive = foldState(rows.filter((r) => r.role === "system").map((r) => r.content)).sensitive || c.sensitivity !== "normal";
  // Only the turns not already in the summary.
  const fresh = turnsAfter(rows.filter((r) => r.role !== "system"), c.summary ? c.summaryUpToMessageId : null);
  const split = compactSplit(fresh.map((r) => ({ id: r.id, role: r.role, content: r.content, citations: r.citations })));
  if (!split) throw new InboxError(409, "This conversation is too short to compact. Keep going, then try again.");
  let summary: string;
  let degraded = false;
  try {
    const r = await mux.complete({
      route: sensitive ? "agent" : "fast", messages: compactMessages(split.older, c.summary), maxTokens: 600, temperature: 0.2,
      meta: { userId: v.id, agent: "my-graph:chat-compact", traceId: c.id, sensitive, graphId: v.graphId },
    });
    summary = cleanSummary(r.text) || fallbackSummary(split.older, c.summary);
  } catch {
    summary = fallbackSummary(split.older, c.summary);
    degraded = true;
  }
  await saveSummary(c.id, summary, split.upTo.id);
  void logActivity({
    graphId: v.graphId, userId: v.id, actor: "chat", action: "compacted_conversation",
    summary: `Compacted "${c.title}" (${split.older.length} earlier messages summarised)`, subjectType: "conversation", subjectId: c.id,
    conversationId: c.id, visibility: "private",
  }).catch(() => {});
  return { summary, upToMessageId: split.upTo.id, compacted: split.older.length, degraded };
}

const g = globalThis as unknown as { __mgAutoCompact?: Set<string> };
const running = g.__mgAutoCompact ?? (g.__mgAutoCompact = new Set());

/**
 * After a turn: summarise a long session's older turns so the next turns send a short, stable history (see
 * autoCompactSplit). Quiet (no activity entry) and best-effort; without mux nothing changes and the safety net in
 * trimHistory keeps the prompt bounded.
 */
export async function autoCompact(v: Viewer, id: string): Promise<boolean> {
  if (running.has(id)) return false;
  running.add(id);
  try {
    const c = await ownConversation(v, id);
    if (!c) return false;
    const rows = await conversationRows(c.id);
    const fresh = turnsAfter(rows.filter((r) => r.role !== "system"), c.summary ? c.summaryUpToMessageId : null);
    const split = autoCompactSplit(fresh.map((r) => ({ id: r.id, role: r.role, content: r.content, citations: r.citations })));
    if (!split) return false;
    const sensitive = foldState(rows.filter((r) => r.role === "system").map((r) => r.content)).sensitive || c.sensitivity !== "normal";
    const r = await mux.complete({
      route: sensitive ? "agent" : "fast", messages: compactMessages(split.older, c.summary), maxTokens: 600, temperature: 0.2,
      meta: { userId: v.id, agent: "my-graph:chat-compact", traceId: c.id, sensitive, graphId: v.graphId },
    });
    const summary = cleanSummary(r.text);
    if (!summary) return false;
    await saveSummary(c.id, summary, split.upTo.id);
    return true;
  } catch (e) {
    if (!mux.isMuxDown(e)) console.warn("[assistant] auto-compact failed:", e instanceof Error ? e.message : e);
    return false;
  } finally {
    running.delete(id);
  }
}
