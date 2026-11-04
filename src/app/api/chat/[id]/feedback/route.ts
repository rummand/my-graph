import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { conversationIdSchema, feedbackSchema, firstIssue, handle, jsonError, readJson } from "@/lib/assistant/http";
import { setFeedback } from "@/lib/assistant/store";

export const dynamic = "force-dynamic";

/** POST /api/chat/[id]/feedback { messageId, value: 1 | -1 | null } — thumbs up / down on an answer. */
export function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const v = await requireUser();
    const id = conversationIdSchema.safeParse((await params).id);
    if (!id.success) return jsonError(404, "That conversation doesn't exist or isn't yours.");
    const body = await readJson(req);
    if (body === null) return jsonError(400, "Send the feedback as JSON.");
    const parsed = feedbackSchema.safeParse(body);
    if (!parsed.success) return jsonError(400, firstIssue(parsed.error));
    if (!(await setFeedback(v, id.data, parsed.data.messageId, parsed.data.value))) return jsonError(404, "That answer isn't part of this conversation.");
    return NextResponse.json({ ok: true, value: parsed.data.value });
  });
}
