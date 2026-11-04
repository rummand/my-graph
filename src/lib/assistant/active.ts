/**
 * The always-active session (pure, unit-tested). One active conversation per person per graph, kept on the server so
 * it follows reloads, devices and the iOS app. A stored row with no conversation means "a new conversation is open"
 * (the next question starts one); no row at all means the person never chose, so the latest conversation is active.
 */

export type StoredSession = { conversationId: string | null } | null;

/** What happens to the active session. */
export type SessionEvent =
  | { type: "asked"; conversationId: string }   // a question was answered in this conversation (new or old)
  | { type: "opened"; conversationId: string }  // a saved session was reopened
  | { type: "new" }                             // "New conversation"
  | { type: "deleted"; conversationId: string };

/** The active conversation id, given the stored choice and the conversations this person has in this graph. */
export function pickActive(stored: StoredSession, conversations: { id: string; updatedAt: string }[]): string | null {
  if (stored) return stored.conversationId && conversations.some((c) => c.id === stored.conversationId) ? stored.conversationId : null;
  let best: { id: string; t: number } | null = null;
  for (const c of conversations) {
    const t = Date.parse(c.updatedAt);
    if (!best || (Number.isFinite(t) && t > best.t)) best = { id: c.id, t: Number.isFinite(t) ? t : -Infinity };
  }
  return best?.id ?? null;
}

/** The active conversation after an event; `current` is the active one before it. */
export function activeAfter(current: string | null, ev: SessionEvent): string | null {
  switch (ev.type) {
    case "asked":
    case "opened":
      return ev.conversationId;
    case "new":
      return null;
    case "deleted":
      return current === ev.conversationId ? null : current;
  }
}

/** Key for one person's session in one graph: sessions never cross graphs. */
export const sessionKey = (graphId: string, userId: string) => `${graphId}:${userId}`;

/** An in-memory session table with the same rules as the database one (used by tests and as the reference). */
export class SessionTable {
  private rows = new Map<string, string | null>();
  get(graphId: string, userId: string): StoredSession {
    const k = sessionKey(graphId, userId);
    return this.rows.has(k) ? { conversationId: this.rows.get(k) ?? null } : null;
  }
  apply(graphId: string, userId: string, ev: SessionEvent): string | null {
    const k = sessionKey(graphId, userId);
    const next = activeAfter(this.rows.get(k) ?? null, ev);
    this.rows.set(k, next);
    return next;
  }
}
