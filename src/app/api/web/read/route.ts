import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { scopeOf } from "@/lib/graphs/pure";
import { readUrl } from "@/lib/web";
import { handle, jsonError, readBody, webGate } from "../http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const body = z.object({
  url: z.string().trim().url("That isn't a web address.").max(2000),
  conversationId: z.uuid().nullish(),
}).strict();

/**
 * POST /api/web/read { url, conversationId? } → { sourceId, url, title, via, reused, chars }.
 * Reads one public page (private, loopback and internal addresses are refused) and saves it as a web source in the
 * current graph: kind "web", the URL, title, when it was fetched and the text read, so it can be cited like any source.
 */
export function POST(req: Request) {
  return handle(async () => {
    const v = await requireUser();
    if (!scopeOf(v).canWrite) return jsonError(403, "You can look at this graph but not add to it.");
    const gate = await webGate(v);
    if (gate) return gate;
    const parsed = body.safeParse(await readBody(req));
    if (!parsed.success) return jsonError(400, parsed.error.issues[0]?.message ?? "The request is not valid.");
    const p = await readUrl(v, parsed.data.url, { conversationId: parsed.data.conversationId, signal: req.signal });
    return NextResponse.json({ sourceId: p.sourceId, url: p.url, title: p.title, via: p.via, reused: p.reused, chars: p.text.length });
  });
}
