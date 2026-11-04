import { NextResponse } from "next/server";
import { createCorpus, listCorpora } from "@/lib/corpus";
import { corpusBody } from "@/lib/corpus/schemas";
import { parseBody, route } from "@/lib/compliance/http";

export const dynamic = "force-dynamic";

/** GET: the current graph's corpora with their coverage. */
export const GET = route(async (_req, v) => ({ corpora: await listCorpora(v) }));

/** POST { name, kind, authority, binding, version, effectiveFrom, scope … }: a new corpus (and its node in the graph). */
export const POST = route(async (req, v) => {
  const body = await parseBody(req, corpusBody);
  return NextResponse.json({ corpus: await createCorpus(v, body) }, { status: 201 });
});
