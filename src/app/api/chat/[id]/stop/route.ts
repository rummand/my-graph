import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { stopTurn } from "@/lib/assistant/chat";
import { conversationIdSchema, handle, jsonError } from "@/lib/assistant/http";
import { ownConversation } from "@/lib/assistant/store";

export const dynamic = "force-dynamic";

/** POST /api/chat/[id]/stop — stop the answer being written; what was written so far is kept. */
export function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handle(async () => {
    const v = await requireUser();
    const id = conversationIdSchema.safeParse((await params).id);
    if (!id.success || !(await ownConversation(v, id.data))) return jsonError(404, "That conversation doesn't exist or isn't yours.");
    return NextResponse.json({ ok: true, stopped: stopTurn(v, id.data) });
  });
}
