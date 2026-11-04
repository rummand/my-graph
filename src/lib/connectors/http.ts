/**
 * Route plumbing for /api/connections: the viewer, zod parsing, JSON { error } with proper statuses. Same-origin
 * (CSRF) is enforced for every state-changing /api request by middleware; handlers only run after it passed.
 * Error messages never contain secrets (connector errors are redacted before they are stored).
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUserApi, type Viewer } from "@/lib/auth";
import { ConnectionError } from "./store";

export function errorJson(status: number, error: string, extra?: Record<string, unknown>) {
  return NextResponse.json({ error, ...(extra ?? {}) }, { status });
}

export async function parseJson<T extends z.ZodType>(req: Request, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  const text = await req.text();
  if (text.length > 50_000) throw new ConnectionError(413, "That request is too large.");
  try {
    raw = text.trim() ? JSON.parse(text) : {};
  } catch {
    throw new ConnectionError(400, "The request body isn't valid JSON.");
  }
  const r = schema.safeParse(raw);
  if (!r.success) throw new ConnectionError(400, r.error.issues[0]?.message ?? "Some fields need fixing.");
  return r.data;
}

export function parseId(value: unknown): string {
  const r = z.uuid().safeParse(value);
  if (!r.success) throw new ConnectionError(404, "This connection doesn't exist.");
  return r.data;
}

export function route<C>(fn: (req: Request, v: Viewer, ctx: C) => Promise<Response | unknown>) {
  return async (req: Request, ctx: C) => {
    try {
      const v = await requireUserApi();
      const out = await fn(req, v, ctx);
      return out instanceof Response ? out : NextResponse.json(out);
    } catch (e) {
      if (e instanceof Response) return e;
      if (e instanceof ConnectionError) return errorJson(e.status, e.message, e.code ? { code: e.code } : undefined);
      console.error("[connections api]", e instanceof Error ? e.message : e);
      return errorJson(500, "Something went wrong on our side. Please try again.");
    }
  };
}

const secretsBody = z.record(z.string().max(40), z.string().max(2000)).optional();
const configBody = z.record(z.string().max(40), z.unknown()).optional();

export const createBody = z.object({
  connector: z.string().max(40),
  label: z.string().max(120).optional(),
  config: configBody,
  secrets: secretsBody,
  everyMinutes: z.number().int().min(15).max(10080).optional(),
});

export const patchBody = z.object({
  label: z.string().max(120).optional(),
  config: configBody,
  secrets: secretsBody,
  everyMinutes: z.number().int().min(15).max(10080).optional(),
  paused: z.boolean().optional(),
}).refine((b) => Object.keys(b).length > 0, "Nothing to change.");
