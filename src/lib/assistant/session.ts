/**
 * The always-active assistant session (server-only): one active conversation per person per graph, stored in
 * `assistant_sessions`, so the Ask panel, /chat and the iOS app all open on the same conversation. Rules in ./active.
 * Also resolves page context (what is open when a question is asked) by re-reading the item as the viewer.
 */
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { assistantSessions } from "@/db/schema";
import type { Viewer } from "@/lib/auth";
import * as gbrain from "@/lib/gbrain";
import { getReadableSource } from "@/lib/ingest/library";
import * as wiki from "@/lib/pages";
import { getArtifact } from "@/lib/artifacts";
import { getChangeSet } from "@/lib/changes";
import { getCorpus } from "@/lib/corpus";
import { allowed, loadClient, loadSession } from "@/lib/clinical";
import { pickActive, type StoredSession } from "./active";
import { listConversations, ownConversation, type ConversationSummary } from "./store";
import type { PageContext, ResolvedPage } from "./page-context";

async function stored(v: Viewer): Promise<StoredSession> {
  const [row] = await db.select({ conversationId: assistantSessions.conversationId }).from(assistantSessions)
    .where(and(eq(assistantSessions.graphId, v.graphId), eq(assistantSessions.userId, v.id))).limit(1);
  return row ? { conversationId: row.conversationId } : null;
}

/** The active conversation in this graph (null: a new conversation is open), with the saved sessions. */
export async function getActiveSession(v: Viewer): Promise<{ conversationId: string | null; conversations: ConversationSummary[] }> {
  const [s, conversations] = await Promise.all([stored(v), listConversations(v)]);
  return { conversationId: pickActive(s, conversations), conversations };
}

/** Make a conversation active (null = start a new one with the next question). False when it isn't the viewer's. */
export async function setActiveSession(v: Viewer, conversationId: string | null): Promise<boolean> {
  if (conversationId && !(await ownConversation(v, conversationId))) return false;
  await db.insert(assistantSessions)
    .values({ graphId: v.graphId, userId: v.id, conversationId, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [assistantSessions.graphId, assistantSessions.userId],
      set: { conversationId: sql`excluded.conversation_id`, updatedAt: sql`excluded.updated_at` },
    });
  return true;
}

/**
 * Read what the page shows as the viewer. Anything they can't read (or that doesn't exist) is dropped, so a title
 * sent by the browser never reaches the model unchecked.
 */
export async function resolvePage(v: Viewer, p: PageContext): Promise<ResolvedPage | null> {
  const base = { kind: p.kind, id: p.id, path: p.path };
  try {
    switch (p.kind) {
      case "person":
      case "node": {
        if (!gbrain.isUuid(p.id)) return null;
        const n = await gbrain.getNode(v, p.id);
        return n ? { ...base, title: n.label, nodeId: n.id } : null;
      }
      case "library": {
        if (!gbrain.isUuid(p.id)) return null;
        const s = await getReadableSource(v, p.id);
        return s ? { ...base, title: s.title, nodeId: s.nodeId ?? null } : null;
      }
      case "wiki": {
        const w = await wiki.getPage(v, p.id);
        return w ? { ...base, title: w.title, nodeId: w.nodeId } : null;
      }
      case "document": {
        const a = await getArtifact(v, p.id);
        return { ...base, title: a.artifact.title, nodeId: null };
      }
      case "change_set": {
        if (!gbrain.isUuid(p.id)) return null;
        const c = await getChangeSet(v, p.id);
        return c ? { ...base, title: c.title, nodeId: null } : null;
      }
      case "corpus": {
        const c = await getCorpus(v, p.id);
        return { ...base, title: c.name, nodeId: c.nodeId };
      }
      // Clinical records lead only for someone with clinical access, and only while the client's consent covers
      // analysis; otherwise the open record never reaches the model as context.
      case "client": {
        const rec = await loadClient(v, p.id);
        return allowed(rec, "summary") ? { ...base, title: rec.label, nodeId: rec.id } : null;
      }
      case "clinical_session": {
        const { session, client } = await loadSession(v, p.id);
        if (!allowed(client, "summary")) return null;
        const title = session.title?.trim() ? `${session.title.trim()} (${client.label})` : client.label;
        return { ...base, title, nodeId: client.id };
      }
    }
  } catch {
    return null;
  }
}
