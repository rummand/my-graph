import { NextResponse } from "next/server";
import { createArtifact, listArtifacts } from "@/lib/artifacts";
import { apiRoute, createArtifactBody, parseBody } from "@/lib/artifacts/http";

export const dynamic = "force-dynamic";

/** GET: documents in my current graph I may see (my drafts, published ones shared with me). */
export const GET = apiRoute(async (_req, v) => ({ artifacts: await listArtifacts(v) }));

/** POST { kind, title, query: { about, question, from, to, text }, designSetId?, blank? }: a draft; the assistant drafts it in the background. */
export const POST = apiRoute(async (req, v) => {
  const body = await parseBody(req, createArtifactBody);
  const artifact = await createArtifact(v, {
    kind: body.kind, title: body.title, designSetId: body.designSetId, blank: body.blank,
    query: { about: body.query.about, question: body.query.question, from: body.query.from ?? null, to: body.query.to ?? null, text: body.query.text },
  });
  return NextResponse.json({ artifact }, { status: 201 });
});
