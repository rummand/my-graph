import { z } from "zod";
import { ArtifactError, getArtifact, restoreVersion } from "@/lib/artifacts";
import { apiRoute, parseId } from "@/lib/artifacts/http";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string; version: string }> };

/** POST: restore that version's title and content as a new version. */
export const POST = apiRoute<Ctx>(async (_req, v, ctx) => {
  const p = await ctx.params;
  const id = parseId(p.id);
  const n = z.coerce.number().int().min(1).safeParse(p.version);
  if (!n.success) throw new ArtifactError(404, "That version isn't here.");
  await restoreVersion(v, id, n.data);
  return getArtifact(v, id);
});
