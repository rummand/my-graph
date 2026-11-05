import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { conversationIdSchema, firstIssue, handle, jsonError, readJson } from "@/lib/assistant/http";
import { ownConversation } from "@/lib/assistant/store";
import { settleClientAction } from "@/lib/assistant/client-actions";
import { actionOutcomeSchema, type ClientActionOutcome } from "@/lib/assistant/page-actions";

export const dynamic = "force-dynamic";

/**
 * POST /api/chat/[id]/action { callId, status, result?, summary?, error? } — the browser's answer to a page action
 * the assistant called in this conversation (it ran it, the person said not now, it failed, or the page is gone).
 * The waiting answer then carries on. Only the person who asked can answer.
 */
export function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const v = await requireUser();
    const id = conversationIdSchema.safeParse((await params).id);
    if (!id.success || !(await ownConversation(v, id.data))) return jsonError(404, "That conversation doesn't exist or isn't yours.");
    const body = await readJson(req);
    const parsed = actionOutcomeSchema.safeParse(body);
    if (!parsed.success) return jsonError(400, firstIssue(parsed.error));
    const b = parsed.data;
    const outcome: ClientActionOutcome = b.status === "done" ? { status: "done", result: b.result, summary: b.summary ?? null }
      : b.status === "declined" ? { status: "declined" }
        : b.status === "failed" ? { status: "failed", error: b.error || "It didn't work." }
          : { status: "unavailable", error: b.error ?? undefined };
    const ok = settleClientAction({ callId: b.callId, userId: v.id, conversationId: id.data }, outcome);
    if (!ok) return jsonError(409, "The answer isn't waiting for this any more.");
    return NextResponse.json({ ok: true });
  });
}
