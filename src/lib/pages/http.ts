/** Route-handler plumbing for /api/pages: auth, zod parsing and consistent `{ error }` JSON. */
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser, type Viewer } from "@/lib/auth";
import { DocError } from "./doc";
import { PageError } from "./errors";

/** Parse a JSON body with a zod schema; 400 with field messages when it doesn't fit. */
export async function parseBody<T extends z.ZodType>(req: Request, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    const text = await req.text();
    raw = text.trim() ? JSON.parse(text) : {};
  } catch {
    throw new PageError(400, "The request body isn't valid JSON.");
  }
  const r = schema.safeParse(raw);
  if (!r.success) {
    const first = r.error.issues[0];
    throw new PageError(400, first ? first.message : "Some fields need fixing.", {
      fields: r.error.issues.map((i) => ({ key: i.path.join("."), message: i.message })),
    });
  }
  return r.data;
}

export function parseQuery<T extends z.ZodType>(req: Request, schema: T): z.infer<T> {
  const params = Object.fromEntries([...new URL(req.url).searchParams].filter(([, v]) => v !== ""));
  const r = schema.safeParse(params);
  if (!r.success) throw new PageError(400, r.error.issues[0]?.message ?? "Invalid query.");
  return r.data;
}

export const slugParam = z.object({ slug: z.string().min(1).max(120).regex(/^[a-z0-9-]+$/, "That page address isn't valid.") });

/** Wrap a handler: resolves the viewer and maps thrown errors to JSON with the right status. */
export function route<P extends Record<string, string>>(fn: (req: Request, v: Viewer, params: P) => Promise<Response | unknown>) {
  return async (req: Request, ctx: { params: Promise<P> }): Promise<Response> => {
    try {
      const v = await requireUser();
      const out = await fn(req, v, await ctx.params);
      return out instanceof Response ? out : NextResponse.json(out);
    } catch (e) {
      return errorResponse(e);
    }
  };
}

export function errorResponse(e: unknown): Response {
  if (e instanceof Response) {
    if (e.headers.get("content-type")?.includes("json")) return e;
    return NextResponse.json({ error: e.status === 403 ? "You don't have access to this." : "Please sign in again." }, { status: e.status || 401 });
  }
  if (e instanceof PageError) return NextResponse.json({ error: e.message, ...(e.details ?? {}) }, { status: e.status });
  if (e instanceof z.ZodError) return NextResponse.json({ error: e.issues[0]?.message ?? "Invalid request." }, { status: 400 });
  if (e instanceof DocError) return NextResponse.json({ error: e.message }, { status: 422 });
  console.error("[wiki api]", e);
  return NextResponse.json({ error: "Something went wrong on our side. Your last change may not be saved — try again in a moment." }, { status: 500 });
}
