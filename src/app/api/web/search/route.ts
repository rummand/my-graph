import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { searchWeb } from "@/lib/web";
import { handle, jsonError, readBody, webGate } from "../http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const body = z.object({
  query: z.string().trim().min(2, "Type what to search for.").max(400, "Keep the search under 400 characters."),
  limit: z.number().int().min(1).max(20).optional(),
}).strict();

/**
 * POST /api/web/search { query, limit? } → { query, results: [{ title, url, snippet, engine, published }] }.
 * The query is minimised before it leaves (names and the topic; no CPR, e-mail, phone or health words): `query`
 * in the answer is what was actually sent. Nothing is saved; read a result with POST /api/web/read.
 */
export function POST(req: Request) {
  return handle(async () => {
    const v = await requireUser();
    const gate = await webGate(v);
    if (gate) return gate;
    const parsed = body.safeParse(await readBody(req));
    if (!parsed.success) return jsonError(400, parsed.error.issues[0]?.message ?? "The request is not valid.");
    return NextResponse.json(await searchWeb(v, parsed.data.query, { limit: parsed.data.limit, signal: req.signal }));
  });
}
