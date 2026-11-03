import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { ChatInputError, prepareTurn, runTurn } from "@/lib/assistant/chat";
import { chatRequestSchema, firstIssue, handle, jsonError, readJson } from "@/lib/assistant/http";
import { listConversations } from "@/lib/assistant/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /api/chat — the viewer's conversations, newest first. */
export function GET() {
  return handle(async () => {
    const v = await requireUser();
    return NextResponse.json({ conversations: await listConversations(v) });
  });
}

/**
 * POST /api/chat { conversationId?, question } — ask; answers as a Server-Sent Events stream
 * (events: start, delta, done, error — see src/lib/assistant/chat.ts).
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
    const stream = runTurn(v, turn, parsed.data.question, req.signal);
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
