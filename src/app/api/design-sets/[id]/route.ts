import { z } from "zod";
import { archiveDesignSet, DesignSetError, getDesignSet, readabilityWarnings, updateDesignSet } from "@/lib/design-sets";
import { apiRoute, designSetPatch, parseBody } from "@/lib/artifacts/http";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

const idParam = z.string().trim().min(1).max(64);
async function idOf(ctx: Ctx) {
  const r = idParam.safeParse((await ctx.params).id);
  if (!r.success) throw new DesignSetError(404, "That design set isn't here.");
  return r.data;
}

export const GET = apiRoute<Ctx>(async (_req, v, ctx) => {
  const s = await getDesignSet(v, await idOf(ctx));
  if (!s) throw new DesignSetError(404, "That design set isn't here.");
  return { designSet: s, warnings: readabilityWarnings(s.tokens) };
});

/** PATCH { name?, description?, tokens?, templates? }: saved as a new version. */
export const PATCH = apiRoute<Ctx>(async (req, v, ctx) => {
  const body = await parseBody(req, designSetPatch);
  const s = await updateDesignSet(v, await idOf(ctx), body);
  return { designSet: s, warnings: readabilityWarnings(s.tokens) };
});

/** DELETE: archive (published documents keep their pinned look). */
export const DELETE = apiRoute<Ctx>(async (_req, v, ctx) => {
  await archiveDesignSet(v, await idOf(ctx));
  return { ok: true };
});
