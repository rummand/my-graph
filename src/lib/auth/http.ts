/** Route-handler plumbing for /api/auth: JSON errors, zod parsing, client IP. */
import { NextResponse } from "next/server";
import { z } from "zod";

export class AuthError extends Error {
  constructor(public status: number, message: string, public extra?: Record<string, unknown>) {
    super(message);
    this.name = "AuthError";
  }
}

export function errorJson(status: number, error: string, extra?: Record<string, unknown>, headers?: HeadersInit) {
  return NextResponse.json({ error, ...(extra ?? {}) }, { status, headers });
}

export async function parseBody<T extends z.ZodType>(req: Request, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    const text = await req.text();
    raw = text.trim() ? JSON.parse(text) : {};
  } catch {
    throw new AuthError(400, "The request body isn't valid JSON.");
  }
  const r = schema.safeParse(raw);
  if (!r.success) {
    const fields = r.error.issues.map((i) => ({ key: i.path.join("."), message: i.message }));
    throw new AuthError(400, fields[0]?.message ?? "Some fields need fixing.", { fields });
  }
  return r.data;
}

export function parseParams<T extends z.ZodType>(params: unknown, schema: T): z.infer<T> {
  const r = schema.safeParse(params);
  if (!r.success) throw new AuthError(400, r.error.issues[0]?.message ?? "Invalid request.");
  return r.data;
}

/** Runs a handler and maps thrown Responses, AuthErrors and unexpected errors to JSON. */
export async function handle(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof Response) return e;
    if (e instanceof AuthError) return errorJson(e.status, e.message, e.extra);
    console.error("[auth api]", e);
    return errorJson(500, "Something went wrong on our side. Please try again.");
  }
}
