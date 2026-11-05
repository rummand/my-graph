/** Route plumbing for /api/you: the signed-in person only, same-origin writes, zod bodies, `{ error }` JSON. */
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUserApi, type Viewer } from "@/lib/auth";
import { isAllowedOrigin } from "@/lib/security/origin";
import { YouError } from "./index";

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

export const insightParams = z.object({ id: z.uuid() });

export function youRoute<C>(fn: (req: Request, v: Viewer, ctx: C) => Promise<unknown>) {
  return async (req: Request, ctx: C): Promise<Response> => {
    try {
      if (!SAFE.has(req.method) && !isAllowedOrigin({
        origin: req.headers.get("origin"), secFetchSite: req.headers.get("sec-fetch-site"), host: req.headers.get("host"),
        forwardedHost: req.headers.get("x-forwarded-host"), appUrl: process.env.APP_URL,
      })) return NextResponse.json({ error: "This request came from another site and was blocked." }, { status: 403 });
      const v = await requireUserApi();
      const out = await fn(req, v, ctx);
      return out instanceof Response ? out : NextResponse.json(out, { headers: { "cache-control": "private, no-store" } });
    } catch (e) {
      if (e instanceof Response) return e;
      if (e instanceof YouError) return NextResponse.json({ error: e.message }, { status: e.status });
      if (e instanceof z.ZodError) {
        const i = e.issues[0];
        return NextResponse.json({ error: i ? `${i.path.join(".") || "Request"}: ${i.message}` : "Invalid request." }, { status: 400 });
      }
      const status = (e as { status?: unknown })?.status;
      if (e instanceof Error && typeof status === "number" && status >= 400 && status < 500) return NextResponse.json({ error: e.message }, { status });
      console.error("[you api]", e);
      return NextResponse.json({ error: "Something went wrong on our side. Try again in a moment." }, { status: 500 });
    }
  };
}

export async function jsonBody<T extends z.ZodType>(req: Request, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try { raw = await req.json(); } catch { throw new YouError(400, "Send a JSON body."); }
  return schema.parse(raw);
}
