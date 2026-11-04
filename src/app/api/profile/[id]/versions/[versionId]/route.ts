import { z } from "zod";
import { getVersion } from "@/lib/profile";
import { profileRoute } from "@/lib/profile/http";

type Ctx = { params: Promise<{ id: string; versionId: string }> };
const params = z.object({ id: z.uuid(), versionId: z.uuid() });

/** GET /api/profile/:id/versions/:versionId → one version of the written doc, to read. */
export const GET = profileRoute<Ctx>(async (_req, v, ctx) => {
  const { id, versionId } = params.parse(await ctx.params);
  return getVersion(v, id, versionId);
});
