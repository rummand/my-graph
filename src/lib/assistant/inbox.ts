/** Conversation inbox actions that need a model (server-only): "Compact this conversation". */
import type { Viewer } from "@/lib/auth";
import { logActivity } from "@/lib/automations";
import * as mux from "@/lib/mux";
import { cleanSummary, compactMessages, compactSplit, fallbackSummary, turnsAfter } from "./compact";
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
  const split = compactSplit(fresh.map((r) => ({ id: r.id, role: r.role, content: r.content })));
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
