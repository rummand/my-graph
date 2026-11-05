import { NextResponse } from "next/server";
import { handle } from "@/lib/meta/http";
import { lexiconEtag, lexiconPayload, lexiconStamp, loadLexicon } from "@/lib/mentions/live/server";

/**
 * GET /api/annotate/lexicon — every name the viewer may read in the current graph, for instant highlights in the
 * composer. Revalidate with If-None-Match: the ETag changes when the graph (or the viewer's access) changes.
 */
export const GET = handle(async (req, v) => {
  const stamp = await lexiconStamp(v);
  const etag = lexiconEtag(v, stamp);
  const headers = { etag, "cache-control": "private, no-cache", vary: "cookie" };
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
  const lex = await loadLexicon(v, stamp);
  return NextResponse.json({ ...lexiconPayload(v, lex), etag }, { headers });
});
