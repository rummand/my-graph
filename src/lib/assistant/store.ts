/**
 * Conversations and messages (server-only). A conversation belongs to one login, in one graph, and is visible only
 * to them. Inbox controls (Scout): pin, mark unread, rename, search, compact, thumbs up/down.
 */
import { and, asc, desc, eq, ilike, inArray, isNotNull, ne, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { conversations, messages, type AssistantStep, type Citation } from "@/db/schema";
import type { Viewer } from "@/lib/auth";
import type { McpApproval } from "@/lib/mcp-client";
import type { Clarify } from "./clarify";
import { parseProposals, type ProposalView } from "./proposals";
import { isSensitivity, raiseSensitivity, type Sensitivity } from "./sensitivity";
import { decisionKey, encodeState, foldState, type ConversationState } from "./state";
import { likePattern, snippetAround } from "./text";

export type ConversationSummary = {
  id: string; title: string; updatedAt: string; createdAt: string;
  pinned: boolean; unread: boolean; sensitivity: Sensitivity;
  /** Search results only: the matching line. */
  snippet?: string | null;
};

export type MessageView = {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations: Citation[];
  proposals: ProposalView[];
  model: string | null;
  route: string | null;
  createdAt: string;
  steps: AssistantStep[];
  thoughtMs: number | null;
  clarify: Clarify | null;
  feedback: -1 | 1 | null;
  /** Tools at connected services this answer prepared, waiting for the person's approval. */
  mcpApprovals?: McpApproval[];
};

export type ConversationView = ConversationSummary & {
  messages: MessageView[];
  /** Local-models-only (something sensitive was discussed). */
  sensitive: boolean;
  summary: string | null;
  /** The last message the summary covers; turns up to it are no longer sent to the model. */
  summaryUpToMessageId: string | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ConvRow = typeof conversations.$inferSelect;

function summaryOf(r: Pick<ConvRow, "id" | "title" | "updatedAt" | "createdAt" | "pinnedAt" | "unreadAt" | "sensitivity">): ConversationSummary {
  return {
    id: r.id, title: r.title, updatedAt: r.updatedAt.toISOString(), createdAt: r.createdAt.toISOString(),
    pinned: !!r.pinnedAt, unread: !!r.unreadAt, sensitivity: isSensitivity(r.sensitivity) ? r.sensitivity : "normal",
  };
}

const own = (v: Viewer) => and(eq(conversations.userId, v.id), eq(conversations.graphId, v.graphId));

export async function listConversations(v: Viewer, limit = 100): Promise<ConversationSummary[]> {
  const rows = await db.select().from(conversations)
    .where(own(v))
    .orderBy(desc(conversations.updatedAt))
    .limit(Math.min(Math.max(limit, 1), 500));
  return rows.map(summaryOf);
}

/** Search the viewer's own conversations in this graph by title and message text. */
export async function searchConversations(v: Viewer, q: string, limit = 30): Promise<ConversationSummary[]> {
  const needle = q.trim().slice(0, 200);
  if (!needle) return listConversations(v, limit);
  const pat = likePattern(needle);
  const matchMsg = and(eq(messages.conversationId, conversations.id), ne(messages.role, "system"), ilike(messages.content, pat));
  const rows = await db.select().from(conversations)
    .where(and(own(v), or(ilike(conversations.title, pat), sql`exists (select 1 from ${messages} where ${matchMsg})`)))
    .orderBy(desc(conversations.updatedAt))
    .limit(Math.min(Math.max(limit, 1), 100));
  if (!rows.length) return [];
  // The matching line for each hit (from the visible text, never the hidden proposals block).
  const ids = rows.map((r) => r.id);
  const hits = await db.select({ conversationId: messages.conversationId, content: messages.content, role: messages.role })
    .from(messages)
    .where(and(inArray(messages.conversationId, ids), ne(messages.role, "system"), ilike(messages.content, pat)))
    .orderBy(desc(messages.createdAt))
    .limit(300);
  const snip = new Map<string, string>();
  for (const h of hits) {
    if (snip.has(h.conversationId)) continue;
    const visible = h.role === "assistant" ? parseProposals(h.content).text : h.content;
    const s = snippetAround(visible, needle);
    if (s) snip.set(h.conversationId, s);
  }
  return rows.map((r) => ({ ...summaryOf(r), snippet: snip.get(r.id) ?? null }));
}

/** The conversation row when it belongs to the viewer (and the graph they are working in). */
export async function ownConversation(v: Viewer, id: string) {
  if (!UUID.test(id)) return null;
  const [row] = await db.select().from(conversations)
    .where(and(eq(conversations.id, id), own(v)))
    .limit(1);
  return row ?? null;
}

export async function createConversation(v: Viewer, title: string): Promise<{ id: string }> {
  const [row] = await db.insert(conversations).values({ householdId: v.graphHouseholdId, graphId: v.graphId, userId: v.id, title }).returning({ id: conversations.id });
  return row;
}

export async function renameConversation(id: string, title: string): Promise<void> {
  await db.update(conversations).set({ title }).where(eq(conversations.id, id));
}

export async function touchConversation(id: string): Promise<void> {
  await db.update(conversations).set({ updatedAt: sql`now()` }).where(eq(conversations.id, id));
}

/** Pin / unpin, mark unread / read. Only the viewer's own conversation. */
export async function setFlags(v: Viewer, id: string, flags: { pinned?: boolean; unread?: boolean }): Promise<boolean> {
  if (!(await ownConversation(v, id))) return false;
  const set: Partial<Record<"pinnedAt" | "unreadAt", Date | null>> = {};
  if (flags.pinned !== undefined) set.pinnedAt = flags.pinned ? new Date() : null;
  if (flags.unread !== undefined) set.unreadAt = flags.unread ? new Date() : null;
  if (Object.keys(set).length) await db.update(conversations).set(set).where(and(eq(conversations.id, id), own(v)));
  return true;
}

/** Opening a conversation reads it. */
export async function markRead(v: Viewer, id: string): Promise<void> {
  if (!UUID.test(id)) return;
  await db.update(conversations).set({ unreadAt: null }).where(and(eq(conversations.id, id), own(v), isNotNull(conversations.unreadAt)));
}

/** Raise (never lower) a conversation's sensitivity; returns the new level. */
export async function raiseConversationSensitivity(id: string, current: Sensitivity, next: Sensitivity): Promise<Sensitivity> {
  const level = raiseSensitivity(current, next);
  if (level !== current) await db.update(conversations).set({ sensitivity: level }).where(eq(conversations.id, id));
  return level;
}

export async function saveSummary(id: string, summary: string, upToMessageId: string): Promise<void> {
  await db.update(conversations).set({ summary, summaryUpToMessageId: upToMessageId }).where(eq(conversations.id, id));
}

export async function deleteConversation(v: Viewer, id: string): Promise<boolean> {
  if (!(await ownConversation(v, id))) return false;
  await db.delete(conversations).where(and(eq(conversations.id, id), own(v)));
  return true;
}

export async function addMessage(conversationId: string, m: {
  role: "user" | "assistant" | "system"; content: string; citations?: Citation[]; model?: string | null; route?: string | null; requestId?: string | null;
  steps?: AssistantStep[]; thoughtMs?: number | null; clarify?: Clarify | null;
}): Promise<{ id: string; createdAt: Date }> {
  const [row] = await db.insert(messages).values({
    conversationId, role: m.role, content: m.content, citations: m.citations ?? [], model: m.model ?? null,
    route: m.route ?? null, muxRequestId: m.requestId ?? null, steps: m.steps ?? [], thoughtMs: m.thoughtMs ?? null,
    clarify: m.clarify ?? null,
  }).returning({ id: messages.id, createdAt: messages.createdAt });
  return row;
}

export async function addState(conversationId: string, s: ConversationState): Promise<void> {
  await addMessage(conversationId, { role: "system", content: encodeState(s) });
}

/** Thumbs up (1), down (-1) or cleared (null) on one of the viewer's own answers. */
export async function setFeedback(v: Viewer, conversationId: string, messageId: string, value: -1 | 1 | null): Promise<boolean> {
  if (!UUID.test(messageId) || !(await ownConversation(v, conversationId))) return false;
  const r = await db.update(messages).set({ feedback: value })
    .where(and(eq(messages.id, messageId), eq(messages.conversationId, conversationId), eq(messages.role, "assistant")))
    .returning({ id: messages.id });
  return r.length > 0;
}

type Row = typeof messages.$inferSelect;

async function rowsOf(conversationId: string): Promise<Row[]> {
  return db.select().from(messages).where(eq(messages.conversationId, conversationId)).orderBy(asc(messages.createdAt), asc(messages.id));
}

/** Messages as the UI shows them: state folded in, proposals parsed out of assistant answers. */
export function toViews(rows: Row[]): { messages: MessageView[]; sensitive: boolean } {
  const { decisions, sensitive, mcp } = foldState(rows.filter((r) => r.role === "system").map((r) => r.content));
  const out: MessageView[] = [];
  for (const r of rows) {
    if (r.role === "system") continue;
    const { text, proposals } = r.role === "assistant" ? parseProposals(r.content) : { text: r.content, proposals: [] };
    out.push({
      id: r.id, role: r.role, content: text, citations: r.citations ?? [], model: r.model, route: r.route,
      createdAt: r.createdAt.toISOString(),
      steps: r.steps ?? [], thoughtMs: r.thoughtMs ?? null, clarify: r.clarify ?? null,
      feedback: r.feedback === 1 ? 1 : r.feedback === -1 ? -1 : null,
      ...(mcp.has(r.id) ? { mcpApprovals: mcp.get(r.id) } : {}),
      proposals: proposals.map((p, i) => {
        const d = decisions.get(decisionKey(r.id, i + 1));
        return { ...p, n: i + 1, status: d?.status ?? "pending", result: d?.result ?? null, auto: d?.auto ?? null, keeperNote: d?.why ?? null };
      }),
    });
  }
  return { messages: out, sensitive };
}

export async function getConversation(v: Viewer, id: string): Promise<ConversationView | null> {
  const c = await ownConversation(v, id);
  if (!c) return null;
  const { messages: list, sensitive } = toViews(await rowsOf(c.id));
  return { ...summaryOf(c), messages: list, sensitive, summary: c.summary ?? null, summaryUpToMessageId: c.summaryUpToMessageId ?? null };
}

/** Raw rows (server use: history for the model, proposals for approval). */
export async function conversationRows(conversationId: string): Promise<Row[]> {
  return rowsOf(conversationId);
}
