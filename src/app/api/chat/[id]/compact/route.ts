import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { conversationIdSchema, handle, jsonError } from "@/lib/assistant/http";
import { compactConversation, InboxError } from "@/lib/assistant/inbox";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** POST /api/chat/[id]/compact — summarise earlier turns; the assistant then uses the summary instead of them. */
export function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const v = await requireUser();
    const id = conversationIdSchema.safeParse((await params).id);
    if (!id.success) return jsonError(404, "That conversation doesn't exist or isn't yours.");
    try {
      return NextResponse.json({ ok: true, ...(await compactConversation(v, id.data)) });
    } catch (e) {
      if (e instanceof InboxError) return jsonError(e.status, e.message);
      throw e;
    }
  });
}
