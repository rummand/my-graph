/** Small helpers for the today/briefs route handlers. */
import { NextResponse } from "next/server";

export function jsonError(status: number, error: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ error, ...extra }, { status });
}

/**
 * Runs a route handler body. `requireUser()` throws a Response (401) when signed out — pass it through; anything else
 * unexpected becomes a 500 with a plain message (details go to the server log).
 */
export async function handle(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof Response) return err;
    console.error("[today]", err);
    return jsonError(500, "Something went wrong on our side. Please try again.");
  }
}

/** Parse a JSON body; null when the body is missing or not JSON. */
export async function readJson(req: Request): Promise<unknown | null> {
  try {
    const text = await req.text();
    return text.trim() ? JSON.parse(text) : {};
  } catch {
    return null;
  }
}
