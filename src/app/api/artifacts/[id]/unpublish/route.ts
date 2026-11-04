import { getArtifact, unpublishArtifact } from "@/lib/artifacts";
import { apiRoute, parseId } from "@/lib/artifacts/http";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** POST: back to draft (only the owner sees it again). */
export const POST = apiRoute<Ctx>(async (_req, v, ctx) => {
  const id = parseId((await ctx.params).id);
  await unpublishArtifact(v, id);
  return getArtifact(v, id);
});
