/** Route plumbing for /api/corpora and /api/compliance: the signed-in viewer, zod bodies, JSON errors. */
import { NextResponse } from "next/server";
import { z, ZodError } from "zod";
import { requireUserApi, type Viewer } from "@/lib/auth";
import { CorpusError } from "@/lib/corpus";
import { ComplianceError } from "./index";

export function errorJson(status: number, error: string, extra?: Record<string, unknown>) {
  return NextResponse.json({ error, ...(extra ?? {}) }, { status });
}

export async function parseBody<T extends z.ZodType>(req: Request, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    const text = await req.text();
    if (text.length > 400_000) throw new ComplianceError(413, "That is too much text to check at once.");
    raw = text.trim() ? JSON.parse(text) : {};
  } catch (e) {
    if (e instanceof ComplianceError) throw e;
    throw new ComplianceError(400, "The request body isn't valid JSON.");
  }
  const r = schema.safeParse(raw);
  if (!r.success) throw new ComplianceError(400, r.error.issues[0]?.message ?? "Some fields need fixing.");
  return r.data;
}

export function parseQuery<T extends z.ZodType>(req: Request, schema: T): z.infer<T> {
  const params = Object.fromEntries(new URL(req.url).searchParams);
  const r = schema.safeParse(params);
  if (!r.success) throw new ComplianceError(400, r.error.issues[0]?.message ?? "Some fields need fixing.");
  return r.data;
}

export const uuid = z.string().uuid("That id isn't valid.");

export function route<C>(fn: (req: Request, v: Viewer, ctx: C) => Promise<Response | unknown>) {
  return async (req: Request, ctx: C): Promise<Response> => {
    try {
      const v = await requireUserApi();
      const out = await fn(req, v, ctx);
      return out instanceof Response ? out : NextResponse.json(out);
    } catch (e) {
      if (e instanceof Response) return e;
      if (e instanceof CorpusError || e instanceof ComplianceError) return errorJson(e.status, e.message);
      if (e instanceof ZodError) return errorJson(400, e.issues[0]?.message ?? "Some fields need fixing.");
      const status = (e as { status?: unknown })?.status;
      if (typeof status === "number" && status >= 400 && status < 500 && e instanceof Error) return errorJson(status, e.message);
      console.error("[compliance api]", e);
      return errorJson(500, "Something went wrong on our side. Please try again.");
    }
  };
}
