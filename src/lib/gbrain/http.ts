/** Route-handler plumbing shared by the GBrain API: JSON errors with the right status codes. */
import { NextResponse } from "next/server";
import { z } from "zod";
import { GBrainError } from "./index";

export function json<T>(data: T, init?: ResponseInit) {
  return NextResponse.json(data, init);
}

export function errorJson(status: number, error: string, details?: unknown) {
  return NextResponse.json(details === undefined ? { error } : { error, details }, { status });
}

/** Runs a handler, turning thrown auth Responses, zod errors and GBrainErrors into JSON responses. */
export async function handle(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof Response) {
      if (err.headers.get("content-type")?.includes("json")) return err;
      return errorJson(err.status || 401, err.status === 403 ? "You don't have access to this." : "Please sign in again.");
    }
    if (err instanceof z.ZodError) {
      const first = err.issues[0];
      return errorJson(400, first ? `${first.path.join(".") || "Request"}: ${first.message}` : "Invalid request.", err.issues);
    }
    if (err instanceof GBrainError) return errorJson(err.status, err.message);
    if (err instanceof SyntaxError) return errorJson(400, "The request body isn't valid JSON.");
    console.error("[gbrain api]", err);
    return errorJson(500, "Something went wrong on our side. Please try again.");
  }
}

export async function readJson(req: Request): Promise<unknown> {
  const text = await req.text();
  if (!text.trim()) return {};
  return JSON.parse(text);
}

export const idParam = z.object({ id: z.uuid({ message: "Not a valid id" }) });

/** Query-string helpers: blank strings count as missing. */
export const optionalString = z.preprocess((v) => (v === "" || v === null ? undefined : v), z.string().trim().max(500).optional());
export const optionalInt = (min: number, max: number) =>
  z.preprocess((v) => (v === "" || v === null ? undefined : v), z.coerce.number().int().min(min).max(max).optional());
