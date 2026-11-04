import { getArtifact, redraftArtifact } from "@/lib/artifacts";
import { apiRoute, parseId } from "@/lib/artifacts/http";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** POST: draft a draft again from the same question (the current content stays in versions). */
export const POST = apiRoute<Ctx>(async (_req, v, ctx) => {
  const id = parseId((await ctx.params).id);
  await redraftArtifact(v, id);
  return getArtifact(v, id);
});
