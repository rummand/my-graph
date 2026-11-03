import { NextResponse } from "next/server";
import { audit, requireUser } from "@/lib/auth";
import { conversationIdSchema, firstIssue, handle, jsonError, readJson, renameSchema } from "@/lib/assistant/http";
import { deleteConversation, getConversation, ownConversation, renameConversation } from "@/lib/assistant/store";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/chat/[id] — one conversation with its messages, citations and suggestions. */
export function GET(_req: Request, { params }: Ctx) {
  return handle(async () => {
    const v = await requireUser();
    const id = conversationIdSchema.safeParse((await params).id);
    if (!id.success) return jsonError(404, "That conversation doesn't exist or isn't yours.");
    const conversation = await getConversation(v, id.data);
    if (!conversation) return jsonError(404, "That conversation doesn't exist or isn't yours.");
    return NextResponse.json({ conversation });
  });
}

/** PATCH /api/chat/[id] { title } — rename. */
export function PATCH(req: Request, { params }: Ctx) {
  return handle(async () => {
    const v = await requireUser();
    const id = conversationIdSchema.safeParse((await params).id);
    if (!id.success || !(await ownConversation(v, id.data))) return jsonError(404, "That conversation doesn't exist or isn't yours.");
    const body = await readJson(req);
    if (body === null) return jsonError(400, "Send the new title as JSON.");
    const parsed = renameSchema.safeParse(body);
    if (!parsed.success) return jsonError(400, firstIssue(parsed.error));
    await renameConversation(id.data, parsed.data.title);
    return NextResponse.json({ ok: true, title: parsed.data.title });
  });
}

/** DELETE /api/chat/[id] — delete the conversation and its messages. Facts, reminders and pages it created stay. */
export function DELETE(_req: Request, { params }: Ctx) {
  return handle(async () => {
    const v = await requireUser();
    const id = conversationIdSchema.safeParse((await params).id);
    if (!id.success) return jsonError(404, "That conversation doesn't exist or isn't yours.");
    if (!(await deleteConversation(v, id.data))) return jsonError(404, "That conversation doesn't exist or isn't yours.");
    void audit(v, "chat.delete", { type: "conversation", id: id.data }).catch(() => {});
    return NextResponse.json({ ok: true });
  });
}
