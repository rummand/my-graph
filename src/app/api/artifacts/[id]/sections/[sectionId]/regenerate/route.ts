import { proposeSection } from "@/lib/artifacts";
import { apiRoute, parseBody, parseId, regenBody } from "@/lib/artifacts/http";

export const dynamic = "force-dynamic";
export const maxDuration = 120;
type Ctx = { params: Promise<{ id: string; sectionId: string }> };

/** POST { instruction? }: the assistant proposes a new version of one section, with a diff. Nothing is saved. */
export const POST = apiRoute<Ctx>(async (req, v, ctx) => {
  const p = await ctx.params;
  const { instruction } = await parseBody(req, regenBody);
  return { proposal: await proposeSection(v, parseId(p.id), p.sectionId.slice(0, 64), instruction) };
});
