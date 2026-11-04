import { z } from "zod";
import { ApiError, handle, jsonBody } from "@/lib/meta/http";
import { suggestModelChanges } from "@/lib/meta/suggest";
import { scopeOf } from "@/lib/graphs/pure";

const input = z.object({
  text: z.string().trim().max(12000).optional(),
  sourceId: z.uuid().optional(),
  conversationId: z.uuid().optional(),
  propose: z.boolean().optional(),
}).refine((x) => [x.text, x.sourceId, x.conversationId].filter(Boolean).length === 1, { message: "Send one of text, sourceId or conversationId." });

/**
 * POST /api/meta/suggest — read a small domain model out of a description, a document or a conversation and map it onto
 * this graph. With a document or conversation (or propose: true) it is proposed as a change set; nothing is applied.
 */
export const POST = handle(async (req, v) => {
  const body = await jsonBody(req, input);
  if (body.propose && !scopeOf(v).canWrite) throw new ApiError(403, "You can look at this graph but not add to it.");
  return suggestModelChanges(v, { ...body, propose: scopeOf(v).canWrite ? body.propose : false });
});
