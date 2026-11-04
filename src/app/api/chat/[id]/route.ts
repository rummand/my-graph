import { NextResponse } from "next/server";
import { audit, requireUser } from "@/lib/auth";
import { annotateMessages, memoryAllowedFor } from "@/lib/assistant/apply";
import { conversationIdSchema, firstIssue, handle, jsonError, patchConversationSchema, readJson } from "@/lib/assistant/http";
import { deleteConversation, getConversation, ownConversation, renameConversation, setFlags } from "@/lib/assistant/store";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };
const NOT_FOUND = "That conversation doesn't exist or isn't yours.";

/** GET /api/chat/[id] — one conversation with its messages, steps, citations and suggestions. */
export function GET(_req: Request, { params }: Ctx) {
  return handle(async () => {
    const v = await requireUser();
    const id = conversationIdSchema.safeParse((await params).id);
    if (!id.success) return jsonError(404, NOT_FOUND);
    const conversation = await getConversation(v, id.data);
    if (!conversation) return jsonError(404, NOT_FOUND);
    if (!memoryAllowedFor(v)) for (const m of conversation.messages) m.proposals = m.proposals.filter((p) => p.type !== "propose_memory");
    await annotateMessages(v, conversation.messages, conversation.sensitivity);
    return NextResponse.json({ conversation });
  });
}

/** PATCH /api/chat/[id] { title?, pinned?, unread? } — rename, pin or unpin, mark unread or read. */
export function PATCH(req: Request, { params }: Ctx) {
  return handle(async () => {
    const v = await requireUser();
    const id = conversationIdSchema.safeParse((await params).id);
    if (!id.success || !(await ownConversation(v, id.data))) return jsonError(404, NOT_FOUND);
    const body = await readJson(req);
    if (body === null) return jsonError(400, "Send the change as JSON.");
    const parsed = patchConversationSchema.safeParse(body);
    if (!parsed.success) return jsonError(400, firstIssue(parsed.error));
    const { title, pinned, unread } = parsed.data;
    if (title !== undefined) await renameConversation(id.data, title);
    if (pinned !== undefined || unread !== undefined) await setFlags(v, id.data, { pinned, unread });
    return NextResponse.json({ ok: true, ...parsed.data });
  });
}

/** DELETE /api/chat/[id] — delete the conversation and its messages. Facts, reminders and pages it created stay. */
export function DELETE(_req: Request, { params }: Ctx) {
  return handle(async () => {
    const v = await requireUser();
    const id = conversationIdSchema.safeParse((await params).id);
    if (!id.success) return jsonError(404, NOT_FOUND);
    if (!(await deleteConversation(v, id.data))) return jsonError(404, NOT_FOUND);
    void audit(v, "chat.delete", { type: "conversation", id: id.data }).catch(() => {});
    return NextResponse.json({ ok: true });
  });
}
