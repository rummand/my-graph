/** Route-handler plumbing for the library API: viewer lookup, consistent JSON errors. Server-only. */
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser, type Viewer } from "@/lib/auth";
import { IngestError } from "./errors";

export const idParam = z.object({ id: z.string().uuid("That isn't a valid file id.") });

export function jsonError(status: number, error: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ error, ...extra }, { status });
}

/** Run a handler with the signed-in viewer; turn known errors into `{ error }` JSON with the right status. */
export async function withViewer(fn: (v: Viewer) => Promise<Response>): Promise<Response> {
  try {
    const v = await requireUser();
    return await fn(v);
  } catch (e) {
    if (e instanceof Response) return e; // requireUser's 401
    if (e instanceof IngestError) return jsonError(e.status, e.message, e.code ? { code: e.code } : {});
    if (e instanceof z.ZodError) return jsonError(400, e.issues[0]?.message ?? "Invalid request.", { issues: e.issues });
    console.error("[library api]", e);
    return jsonError(500, "Something went wrong on our side. Please try again.");
  }
}
