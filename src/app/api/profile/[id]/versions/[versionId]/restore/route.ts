import { z } from "zod";
import { proposeRestore } from "@/lib/profile";
import { profileRoute } from "@/lib/profile/http";

type Ctx = { params: Promise<{ id: string; versionId: string }> };
const params = z.object({ id: z.uuid(), versionId: z.uuid() });

/** POST /api/profile/:id/versions/:versionId/restore → { proposal }. "Restore as a proposal": it waits for a person. */
export const POST = profileRoute<Ctx>(async (_req, v, ctx) => {
  const { id, versionId } = params.parse(await ctx.params);
  return { proposal: await proposeRestore(v, id, versionId) };
});
