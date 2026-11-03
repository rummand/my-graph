/**
 * Conversations and messages (server-only). A conversation belongs to one login and is visible only to them.
 */
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { conversations, messages, type Citation } from "@/db/schema";
import type { Viewer } from "@/lib/auth";
import { parseProposals, type ProposalView } from "./proposals";
import { decisionKey, encodeState, foldState, type ConversationState } from "./state";

export type ConversationSummary = { id: string; title: string; updatedAt: string; createdAt: string };

export type MessageView = {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations: Citation[];
  proposals: ProposalView[];
  model: string | null;
  route: string | null;
  createdAt: string;
};

export type ConversationView = ConversationSummary & { messages: MessageView[]; sensitive: boolean };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function listConversations(v: Viewer, limit = 100): Promise<ConversationSummary[]> {
  const rows = await db.select({ id: conversations.id, title: conversations.title, updatedAt: conversations.updatedAt, createdAt: conversations.createdAt })
    .from(conversations)
    .where(and(eq(conversations.userId, v.id), eq(conversations.householdId, v.householdId)))
    .orderBy(desc(conversations.updatedAt))
    .limit(Math.min(Math.max(limit, 1), 500));
  return rows.map((r) => ({ id: r.id, title: r.title, updatedAt: r.updatedAt.toISOString(), createdAt: r.createdAt.toISOString() }));
}

/** The conversation row when it belongs to the viewer. */
export async function ownConversation(v: Viewer, id: string) {
  if (!UUID.test(id)) return null;
  const [row] = await db.select().from(conversations)
    .where(and(eq(conversations.id, id), eq(conversations.userId, v.id), eq(conversations.householdId, v.householdId)))
    .limit(1);
  return row ?? null;
}

export async function createConversation(v: Viewer, title: string): Promise<{ id: string }> {
  const [row] = await db.insert(conversations).values({ householdId: v.householdId, userId: v.id, title }).returning({ id: conversations.id });
  return row;
}

export async function renameConversation(id: string, title: string): Promise<void> {
  await db.update(conversations).set({ title }).where(eq(conversations.id, id));
}

export async function touchConversation(id: string): Promise<void> {
  await db.update(conversations).set({ updatedAt: sql`now()` }).where(eq(conversations.id, id));
}

export async function deleteConversation(v: Viewer, id: string): Promise<boolean> {
  if (!(await ownConversation(v, id))) return false;
  await db.delete(conversations).where(eq(conversations.id, id));
  return true;
}

export async function addMessage(conversationId: string, m: { role: "user" | "assistant" | "system"; content: string; citations?: Citation[]; model?: string | null; route?: string | null; requestId?: string | null }): Promise<{ id: string; createdAt: Date }> {
  const [row] = await db.insert(messages).values({
    conversationId, role: m.role, content: m.content, citations: m.citations ?? [], model: m.model ?? null,
    route: m.route ?? null, muxRequestId: m.requestId ?? null,
  }).returning({ id: messages.id, createdAt: messages.createdAt });
  return row;
}

export async function addState(conversationId: string, s: ConversationState): Promise<void> {
  await addMessage(conversationId, { role: "system", content: encodeState(s) });
}

type Row = typeof messages.$inferSelect;

async function rowsOf(conversationId: string): Promise<Row[]> {
  return db.select().from(messages).where(eq(messages.conversationId, conversationId)).orderBy(asc(messages.createdAt), asc(messages.id));
}

/** Messages as the UI shows them: state folded in, proposals parsed out of assistant answers. */
export function toViews(rows: Row[]): { messages: MessageView[]; sensitive: boolean } {
  const { decisions, sensitive } = foldState(rows.filter((r) => r.role === "system").map((r) => r.content));
  const out: MessageView[] = [];
  for (const r of rows) {
    if (r.role === "system") continue;
    const { text, proposals } = r.role === "assistant" ? parseProposals(r.content) : { text: r.content, proposals: [] };
    out.push({
      id: r.id, role: r.role, content: text, citations: r.citations ?? [], model: r.model, route: r.route,
      createdAt: r.createdAt.toISOString(),
      proposals: proposals.map((p, i) => {
        const d = decisions.get(decisionKey(r.id, i + 1));
        return { ...p, n: i + 1, status: d?.status ?? "pending", result: d?.result ?? null };
      }),
    });
  }
  return { messages: out, sensitive };
}

export async function getConversation(v: Viewer, id: string): Promise<ConversationView | null> {
  const c = await ownConversation(v, id);
  if (!c) return null;
  const { messages: list, sensitive } = toViews(await rowsOf(c.id));
  return { id: c.id, title: c.title, createdAt: c.createdAt.toISOString(), updatedAt: c.updatedAt.toISOString(), messages: list, sensitive };
}

/** Raw rows (server use: history for the model, proposals for approval). */
export async function conversationRows(conversationId: string): Promise<Row[]> {
  return rowsOf(conversationId);
}
