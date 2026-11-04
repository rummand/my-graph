/** Route plumbing for /api/profile: session, same-origin check on writes, zod bodies, `{ error }` JSON. */
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUserApi, type Viewer } from "@/lib/auth";
import { isMuxDown } from "@/lib/mux";
import { isAllowedOrigin } from "@/lib/security/origin";
import { ProfileDocError } from "./doc";
import { ProfileError } from "./store";

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

export class BadRequest extends Error {
  constructor(message: string, public extra?: Record<string, unknown>) { super(message); }
}

export function profileRoute<C>(fn: (req: Request, v: Viewer, ctx: C) => Promise<unknown>) {
  return async (req: Request, ctx: C): Promise<Response> => {
    try {
      if (!SAFE.has(req.method) && !isAllowedOrigin({
        origin: req.headers.get("origin"), secFetchSite: req.headers.get("sec-fetch-site"), host: req.headers.get("host"),
        forwardedHost: req.headers.get("x-forwarded-host"), appUrl: process.env.APP_URL,
      })) return NextResponse.json({ error: "This request came from another site and was blocked." }, { status: 403 });
      const v = await requireUserApi();
      const out = await fn(req, v, ctx);
      return out instanceof Response ? out : NextResponse.json(out);
    } catch (e) {
      if (e instanceof Response) return e;
      if (e instanceof ProfileError) return NextResponse.json({ error: e.message, ...(e.extra ?? {}) }, { status: e.status });
      if (e instanceof ProfileDocError || e instanceof BadRequest) return NextResponse.json({ error: e.message, ...((e as BadRequest).extra ?? {}) }, { status: 400 });
      if (e instanceof z.ZodError) {
        const i = e.issues[0];
        return NextResponse.json({ error: i ? `${i.path.join(".") || "Request"}: ${i.message}` : "Invalid request." }, { status: 400 });
      }
      if (isMuxDown(e)) return NextResponse.json({ error: "The model gateway (mux) can't be reached right now. Try again in a moment.", muxDown: true }, { status: 503 });
      const status = (e as { status?: unknown })?.status;
      if (e instanceof Error && typeof status === "number" && status >= 400 && status < 500) return NextResponse.json({ error: e.message }, { status });
      console.error("[profile api]", e);
      return NextResponse.json({ error: "Something went wrong on our side. Try again in a moment." }, { status: 500 });
    }
  };
}

export async function jsonOf<T extends z.ZodType>(req: Request, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try { raw = await req.json(); } catch { throw new BadRequest("Send a JSON body."); }
  return schema.parse(raw);
}

export const nodeParams = z.object({ id: z.uuid({ message: "Not a valid id" }) });
