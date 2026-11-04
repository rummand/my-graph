import { commitAnnotations, commitSchema, CommitError } from "@/lib/mentions/annotate";
import { ApiError, handle, jsonBody } from "@/lib/meta/http";
import { audit } from "@/lib/auth";

/**
 * POST /api/annotate/commit { text, conversationId?, plan } — on Send: what the person kept becomes a change set
 * (origin "chat", a receipt per op) and is delivered at once, because Send is their decision.
 */
export const POST = handle(async (req, v) => {
  const body = await jsonBody(req, commitSchema);
  try {
    const r = await commitAnnotations(v, body);
    if (r.applied) void audit(v, "graph.chat_commit", { type: "change_set", id: r.changeSetId ?? v.graphId }, { applied: r.applied, via: r.via }).catch(() => {});
    return r;
  } catch (e) {
    if (e instanceof CommitError) throw new ApiError(e.status, e.message);
    throw e;
  }
});
