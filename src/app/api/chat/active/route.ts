import { NextResponse } from "next/server";
import { isParent, requireUser } from "@/lib/auth";
import { getT } from "@/lib/i18n";
import { muxHealth } from "@/lib/mux";
import { annotateMessages, memoryAllowedFor } from "@/lib/assistant/apply";
import { activeSessionSchema, firstIssue, handle, jsonError, readJson } from "@/lib/assistant/http";
import { getActiveSession, setActiveSession } from "@/lib/assistant/session";
import { getConversation, markRead } from "@/lib/assistant/store";
import { graphStarters } from "@/app/(app)/chat/starters";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/chat/active — the always-active session in this graph: the open conversation (null when a new one is
 * open), the saved sessions, and what the Ask panel needs to show them (model gateway status, starters).
 * `?light=1` answers only { conversationId } (used to notice a switch made on another device).
 */
export function GET(req: Request) {
  return handle(async () => {
    const v = await requireUser();
    const light = new URL(req.url).searchParams.get("light") === "1";
    const { conversationId, conversations } = await getActiveSession(v);
    if (light) return NextResponse.json({ conversationId });
    const t = await getT();
    if (conversationId) await markRead(v, conversationId);
    const [conversation, health, starters] = await Promise.all([
      conversationId ? getConversation(v, conversationId) : Promise.resolve(null),
      muxHealth(),
      graphStarters(v, t),
    ]);
    if (conversation) {
      if (!memoryAllowedFor(v)) for (const m of conversation.messages) m.proposals = m.proposals.filter((p) => p.type !== "propose_memory");
      await annotateMessages(v, conversation.messages, conversation.sensitivity);
    }
    return NextResponse.json({
      conversationId: conversation?.id ?? null,
      conversation,
      conversations: conversations.map((c) => (c.id === conversationId ? { ...c, unread: false } : c)),
      mux: { ok: health.ok, reachable: health.reachable, configured: health.configured },
      canFix: isParent(v),
      starters,
      graphKind: v.graphKind,
    });
  });
}

/** PUT /api/chat/active { conversationId } — reopen a saved session, or null to start a new conversation. */
export function PUT(req: Request) {
  return handle(async () => {
    const v = await requireUser();
    const body = await readJson(req);
    if (body === null) return jsonError(400, "Send the session as JSON.");
    const parsed = activeSessionSchema.safeParse(body);
    if (!parsed.success) return jsonError(400, firstIssue(parsed.error));
    if (!(await setActiveSession(v, parsed.data.conversationId))) return jsonError(404, "That conversation doesn't exist or isn't yours.");
    return NextResponse.json({ conversationId: parsed.data.conversationId });
  });
}
