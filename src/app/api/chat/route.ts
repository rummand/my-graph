import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { ChatInputError, prepareTurn, runTurn } from "@/lib/assistant/chat";
import { chatRequestSchema, firstIssue, handle, jsonError, readJson, searchQuerySchema } from "@/lib/assistant/http";
import { listConversations, searchConversations } from "@/lib/assistant/store";
import { resolvePage, setActiveSession } from "@/lib/assistant/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/chat?q= — the viewer's conversations in this graph, newest first; with q, those matching title or text. */
export function GET(req: Request) {
  return handle(async () => {
    const v = await requireUser();
    const q = searchQuerySchema.safeParse(new URL(req.url).searchParams.get("q") ?? undefined);
    if (!q.success) return jsonError(400, firstIssue(q.error));
    const conversations = q.data ? await searchConversations(v, q.data) : await listConversations(v);
    return NextResponse.json({ conversations });
  });
}

/**
 * POST /api/chat { conversationId?, question, page? } — ask (page: what's open, from the Ask panel); answers as a Server-Sent Events stream
 * (events: start, step, sources, sensitivity, delta, done, error — see src/lib/assistant/chat.ts).
 */
export function POST(req: Request) {
  return handle(async () => {
    const v = await requireUser();
    const body = await readJson(req);
    if (body === null) return jsonError(400, "Send the question as JSON.");
    const parsed = chatRequestSchema.safeParse(body);
    if (!parsed.success) return jsonError(400, firstIssue(parsed.error));
    let turn;
    try {
      turn = await prepareTurn(v, { conversationId: parsed.data.conversationId, question: parsed.data.question });
    } catch (e) {
      if (e instanceof ChatInputError) return jsonError(e.status, e.message);
      throw e;
    }
    // Every question keeps its conversation active, so the panel, /chat and other devices open on it.
    const [page] = await Promise.all([
      parsed.data.page ? resolvePage(v, parsed.data.page) : Promise.resolve(null),
      setActiveSession(v, turn.conversationId).catch((e) => console.error("[chat] active session", e)),
    ]);
    const stream = runTurn(v, turn, parsed.data.question, req.signal, { page });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        "x-accel-buffering": "no",
        "x-conversation-id": turn.conversationId,
      },
    });
  });
}
