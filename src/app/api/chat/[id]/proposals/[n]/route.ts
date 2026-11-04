import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { decideProposal, ProposalError } from "@/lib/assistant/apply";
import { firstIssue, handle, jsonError, proposalBodySchema, proposalParamsSchema, readJson } from "@/lib/assistant/http";

export const dynamic = "force-dynamic";

/**
 * POST /api/chat/[id]/proposals/[n] { messageId, action: "approve" | "always" | "deny" | "dismiss" | "undo" }
 * approve writes the suggestion; always also adds its kind to "Always allow"; deny/dismiss only records the decision;
 * undo takes back what an approval created.
 */
export function POST(req: Request, { params }: { params: Promise<{ id: string; n: string }> }) {
  return handle(async () => {
    const v = await requireUser();
    const p = proposalParamsSchema.safeParse(await params);
    if (!p.success) return jsonError(404, firstIssue(p.error));
    const body = await readJson(req);
    if (body === null) return jsonError(400, "Send the decision as JSON.");
    const parsed = proposalBodySchema.safeParse(body);
    if (!parsed.success) return jsonError(400, firstIssue(parsed.error));
    try {
      const out = await decideProposal(v, { conversationId: p.data.id, messageId: parsed.data.messageId, n: p.data.n, action: parsed.data.action });
      return NextResponse.json({ ok: true, ...out, label: out.result?.label, href: out.result?.href });
    } catch (e) {
      if (e instanceof ProposalError) return jsonError(e.status, e.message);
      throw e;
    }
  });
}
