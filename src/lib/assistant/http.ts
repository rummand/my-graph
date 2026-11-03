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
  action: z.enum(["approve", "dismiss"], { message: "action must be approve or dismiss" }),
}).strict();

export const renameSchema = z.object({
  title: z.string().trim().min(1, "Give the conversation a title").max(120, "Keep the title under 120 characters"),
}).strict();
