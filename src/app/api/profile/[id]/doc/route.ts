import { z } from "zod";
import { readDoc, saveDoc } from "@/lib/profile";
import { jsonOf, nodeParams, profileRoute } from "@/lib/profile/http";

type Ctx = { params: Promise<{ id: string }> };
const schema = z.object({
  doc: z.object({ type: z.literal("doc"), content: z.array(z.unknown()).max(2000).optional() }).passthrough(),
  baseVersion: z.number().int().min(0).nullable(),
}).strict();

/** GET /api/profile/:id/doc → { doc, version, updatedAt, updatedByName, proposals }. */
export const GET = profileRoute<Ctx>(async (_req, v, ctx) => {
  const { id } = nodeParams.parse(await ctx.params);
  return readDoc(v, id);
});

/**
 * PUT /api/profile/:id/doc { doc, baseVersion } → { version, unchanged }. Saves the written part of the profile as a
 * new version (recorded in history). 409 with the current `version` when someone else saved first.
 */
export const PUT = profileRoute<Ctx>(async (req, v, ctx) => {
  const { id } = nodeParams.parse(await ctx.params);
  const { doc, baseVersion } = await jsonOf(req, schema);
  return saveDoc(v, id, doc, baseVersion);
});
