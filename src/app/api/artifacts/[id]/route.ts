import { deleteArtifact, getArtifact, updateArtifact } from "@/lib/artifacts";
import { apiRoute, parseBody, parseId, patchArtifactBody } from "@/lib/artifacts/http";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

/** GET: the document and the design set version it renders with. */
export const GET = apiRoute<Ctx>(async (_req, v, ctx) => getArtifact(v, parseId((await ctx.params).id)));

/** PATCH { title?, content?, designSetId?, visibility?, baseVersion? }: save (a new version). */
export const PATCH = apiRoute<Ctx>(async (req, v, ctx) => {
  const id = parseId((await ctx.params).id);
  const body = await parseBody(req, patchArtifactBody);
  await updateArtifact(v, id, body);
  return getArtifact(v, id);
});

export const DELETE = apiRoute<Ctx>(async (_req, v, ctx) => {
  await deleteArtifact(v, parseId((await ctx.params).id));
  return { ok: true };
});
