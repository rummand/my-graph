import { getArtifact, refreshDesign } from "@/lib/artifacts";
import { apiRoute, parseId } from "@/lib/artifacts/http";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** POST: move a published document to its design set's newest version. */
export const POST = apiRoute<Ctx>(async (_req, v, ctx) => {
  const id = parseId((await ctx.params).id);
  await refreshDesign(v, id);
  return getArtifact(v, id);
});
