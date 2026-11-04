/** Route-handler plumbing for the changes, history and checkpoints APIs: session, zod, `{ error }` JSON. */
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUserApi, type Viewer } from "@/lib/auth";
import { ChangeError } from "./store";

export class HttpError extends Error {
  constructor(public status: number, message: string, public extra?: Record<string, unknown>) { super(message); }
}

export function route<C>(fn: (req: Request, v: Viewer, ctx: C) => Promise<unknown>) {
  return async (req: Request, ctx: C): Promise<Response> => {
    try {
      const v = await requireUserApi();
      const out = await fn(req, v, ctx);
      return out instanceof Response ? out : NextResponse.json(out);
    } catch (e) {
      if (e instanceof Response) return e;
      if (e instanceof HttpError) return NextResponse.json({ error: e.message, ...(e.extra ?? {}) }, { status: e.status });
      if (e instanceof ChangeError) return NextResponse.json({ error: e.message }, { status: e.status });
      if (e instanceof z.ZodError) {
        const i = e.issues[0];
        return NextResponse.json({ error: i ? `${i.path.join(".") || "Request"}: ${i.message}` : "Invalid request." }, { status: 400 });
      }
      const status = (e as { status?: unknown })?.status;
      if (e instanceof Error && typeof status === "number" && status >= 400 && status < 500) return NextResponse.json({ error: e.message }, { status });
      console.error("[changes api]", e);
      return NextResponse.json({ error: "Something went wrong on our side. Try again in a moment." }, { status: 500 });
    }
  };
}

export async function body<T extends z.ZodType>(req: Request, schema: T): Promise<z.infer<T>> {
  let raw: unknown = {};
  const text = await req.text();
  if (text.trim()) {
    try { raw = JSON.parse(text); } catch { throw new HttpError(400, "The request body isn't valid JSON."); }
  }
  return schema.parse(raw);
}

export function query<T extends z.ZodType>(req: Request, schema: T): z.infer<T> {
  const params = Object.fromEntries([...new URL(req.url).searchParams].filter(([, v]) => v !== ""));
  return schema.parse(params);
}

export const idParams = z.object({ id: z.uuid({ message: "Not a valid id" }) });
export const isoDate = z.string().trim().max(40).refine((s) => !Number.isNaN(Date.parse(s)), "Not a date").transform((s) => new Date(s));
