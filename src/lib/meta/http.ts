/** Route-handler wrapper for the meta-model, mentions and annotate APIs: session, zod bodies, `{ error }` JSON. */
import { NextResponse } from "next/server";
import type { z } from "zod";
import { requireUserApi, type Viewer } from "@/lib/auth";
import { isMuxDown } from "@/lib/mux";

export class ApiError extends Error {
  constructor(public status: number, message: string, public extra?: Record<string, unknown>) { super(message); }
}

export async function jsonBody<T extends z.ZodType>(req: Request, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try { raw = await req.json(); } catch { throw new ApiError(400, "Send a JSON body."); }
  const r = schema.safeParse(raw);
  if (!r.success) throw new ApiError(400, "Some fields need fixing.", { fields: r.error.issues.map((i) => ({ key: i.path.join("."), message: i.message })) });
  return r.data;
}

export function handle<C>(fn: (req: Request, v: Viewer, ctx: C) => Promise<unknown>) {
  return async (req: Request, ctx: C): Promise<Response> => {
    try {
      const v = await requireUserApi();
      const out = await fn(req, v, ctx);
      return out instanceof Response ? out : NextResponse.json(out);
    } catch (e) {
      if (e instanceof Response) return e;
      if (e instanceof ApiError) return NextResponse.json({ error: e.message, ...(e.extra ?? {}) }, { status: e.status });
      if (isMuxDown(e)) return NextResponse.json({ error: "The model gateway (mux) can't be reached right now. Try again in a moment.", muxDown: true }, { status: 503 });
      const status = (e as { status?: unknown })?.status;
      if (e instanceof Error && typeof status === "number" && status >= 400 && status < 500) return NextResponse.json({ error: e.message }, { status });
      console.error("[meta api]", e);
      return NextResponse.json({ error: "Something went wrong on our side. Try again in a moment." }, { status: 500 });
    }
  };
}
