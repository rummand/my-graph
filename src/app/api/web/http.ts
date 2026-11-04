/** Shared bits for /api/web/* (server-only). */
import { NextResponse } from "next/server";
import type { Viewer } from "@/lib/auth";
import { getAssistantSettings, webAllowed } from "@/lib/automations";
import { WebError } from "@/lib/web";

export function jsonError(status: number, error: string) {
  return NextResponse.json({ error }, { status });
}

/** Web use needs the "web" capability: on for owners and parents unless switched off, never for children and guests. */
export async function webGate(v: Viewer): Promise<Response | null> {
  const settings = await getAssistantSettings(v);
  return webAllowed(v, settings.capabilities) ? null : jsonError(403, "Web search is turned off for you in this graph.");
}

export async function handle(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof Response) return e;
    if (e instanceof WebError) return jsonError(e.status, e.message);
    console.error("[web]", e);
    return jsonError(500, "Something went wrong on our side. Please try again.");
  }
}

export async function readBody(req: Request): Promise<unknown> {
  try { return await req.json(); } catch { return null; }
}
