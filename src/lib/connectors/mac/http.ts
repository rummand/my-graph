/**
 * Route plumbing for the Mac helper's own door (server-only). The helper has no session: it sends its token as
 * `Authorization: Bearer …` and the person and graph are re-resolved on every call (server.ts helperAuth). It sends no
 * Origin header, so the middleware's same-origin check lets it through; a browser on another site would send one and
 * be refused there. Error messages never contain the token.
 */
import { NextResponse } from "next/server";
import { clientIp } from "@/lib/auth/rate-limit";
import { ConnectionError } from "../store";
import { helperAuth, type HelperAuth } from "./server";

const NO_STORE = { "cache-control": "no-store" };

export function helperRoute<C>(fn: (req: Request, a: HelperAuth, ctx: C) => Promise<unknown>) {
  return async (req: Request, ctx: C) => {
    try {
      const a = await helperAuth(req, clientIp(req.headers));
      const out = await fn(req, a, ctx);
      return out instanceof Response ? out : NextResponse.json(out, { headers: NO_STORE });
    } catch (e) {
      return errorResponse(e);
    }
  };
}

export function errorResponse(e: unknown): Response {
  if (e instanceof ConnectionError) {
    const headers: Record<string, string> = { ...NO_STORE };
    const retry = (e as ConnectionError & { retryAfterSec?: number }).retryAfterSec;
    if (e.status === 429 && retry) headers["retry-after"] = String(retry);
    return NextResponse.json({ error: e.message, ...(e.code ? { code: e.code } : {}) }, { status: e.status, headers });
  }
  console.error("[mac helper]", e instanceof Error ? e.message : "failed");
  return NextResponse.json({ error: "Something went wrong on our side. Please try again." }, { status: 500, headers: NO_STORE });
}

/** The request body as JSON, refusing anything over `max` bytes before parsing it. */
export async function readJson(req: Request, max: number): Promise<unknown> {
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > max) throw new ConnectionError(413, `That batch is too large. Send at most ${Math.floor(max / 1024 / 1024)} MB at a time.`);
  const text = await req.text();
  if (Buffer.byteLength(text, "utf8") > max) throw new ConnectionError(413, `That batch is too large. Send at most ${Math.floor(max / 1024 / 1024)} MB at a time.`);
  try {
    return text.trim() ? JSON.parse(text) : {};
  } catch {
    throw new ConnectionError(400, "The request body isn't valid JSON.");
  }
}

/** A ConnectionError that tells the helper how long to wait. */
export function tooMany(retryAfterSec: number): ConnectionError {
  return Object.assign(new ConnectionError(429, "Too many batches. The helper waits and tries again."), { retryAfterSec });
}
