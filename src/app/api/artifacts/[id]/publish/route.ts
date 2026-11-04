import { getArtifact, publishArtifact } from "@/lib/artifacts";
import { apiRoute, parseBody, parseId, publishBody } from "@/lib/artifacts/http";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** POST { visibility }: a person publishes; the design set version is pinned. */
export const POST = apiRoute<Ctx>(async (req, v, ctx) => {
  const id = parseId((await ctx.params).id);
  const { visibility } = await parseBody(req, publishBody);
  await publishArtifact(v, id, visibility);
  return getArtifact(v, id);
});
