import { acceptSection, getArtifact } from "@/lib/artifacts";
import { acceptBody, apiRoute, parseBody, parseId } from "@/lib/artifacts/http";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string; sectionId: string }> };

/** PUT { section, citations, baseVersion? }: accept a proposed section (merged with its citations, a new version). */
export const PUT = apiRoute<Ctx>(async (req, v, ctx) => {
  const p = await ctx.params;
  const id = parseId(p.id);
  const body = await parseBody(req, acceptBody);
  const section = { ...(body.section as Record<string, unknown>), id: p.sectionId.slice(0, 64) };
  await acceptSection(v, id, { section, citations: body.citations, baseVersion: body.baseVersion });
  return getArtifact(v, id);
});
