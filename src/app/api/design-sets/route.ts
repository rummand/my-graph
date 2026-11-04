import { NextResponse } from "next/server";
import { canEditDesignSets, createDesignSet, graphDefaultSetId, listDesignSets } from "@/lib/design-sets";
import { apiRoute, designSetBody, parseBody } from "@/lib/artifacts/http";

export const dynamic = "force-dynamic";

/** GET: built-in sets plus this graph's own, and which one new documents use. */
export const GET = apiRoute(async (_req, v) => ({
  designSets: await listDesignSets(v), defaultId: await graphDefaultSetId(v), canEdit: canEditDesignSets(v),
}));

/** POST { name, description?, tokens, templates?, sourceUrl? }: a new set in this graph (version 1). */
export const POST = apiRoute(async (req, v) => {
  const body = await parseBody(req, designSetBody);
  const designSet = await createDesignSet(v, body);
  return NextResponse.json({ designSet }, { status: 201 });
});
