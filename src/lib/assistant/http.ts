/** Helpers for the /api/chat route handlers (server-only). */
import { NextResponse } from "next/server";
import { z } from "zod";

export function jsonError(status: number, error: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ error, ...extra }, { status });
}

/** `requireUser()` throws a Response when signed out — pass it through; anything else becomes a plain 500. */
export async function handle(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof Response) return err;
    console.error("[chat]", err);
    return jsonError(500, "Something went wrong on our side. Please try again.");
  }
}

/** JSON body, or null when missing / not JSON. */
export async function readJson(req: Request): Promise<unknown | null> {
  try {
    const text = await req.text();
    return text.trim() ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

export function firstIssue(e: z.ZodError): string {
  const i = e.issues[0];
  return i ? i.message : "The request is not valid.";
}

export const chatRequestSchema = z.object({
  conversationId: z.uuid("Unknown conversation").nullish(),
  question: z.string({ message: "Type a question first." }).trim().min(1, "Type a question first.").max(4000, "Keep the question under 4,000 characters."),
}).strict();

export const conversationIdSchema = z.uuid("Unknown conversation");

export const proposalParamsSchema = z.object({
  id: z.uuid("Unknown conversation"),
  n: z.coerce.number({ message: "Unknown suggestion" }).int("Unknown suggestion").min(1, "Unknown suggestion").max(10, "Unknown suggestion"),
});

export const proposalBodySchema = z.object({
  messageId: z.uuid("Unknown answer"),
  /** "deny" is the ApprovalCard's word for dismiss. */
  action: z.enum(["approve", "always", "dismiss", "deny", "undo"], { message: "action must be approve, always, deny or undo" })
    .transform((a) => (a === "deny" ? "dismiss" : a)),
}).strict();

export const renameSchema = z.object({
  title: z.string().trim().min(1, "Give the conversation a title").max(120, "Keep the title under 120 characters"),
}).strict();

/** PATCH /api/chat/[id]: rename, pin, mark unread — any of them. */
export const patchConversationSchema = z.object({
  title: z.string().trim().min(1, "Give the conversation a title").max(120, "Keep the title under 120 characters").optional(),
  pinned: z.boolean().optional(),
  unread: z.boolean().optional(),
}).strict().refine((b) => b.title !== undefined || b.pinned !== undefined || b.unread !== undefined, "Nothing to change.");

export const feedbackSchema = z.object({
  messageId: z.uuid("Unknown answer"),
  value: z.union([z.literal(1), z.literal(-1), z.null()], { message: "value must be 1, -1 or null" }),
}).strict();

export const searchQuerySchema = z.string().trim().max(200, "Keep the search under 200 characters").optional();
