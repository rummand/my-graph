import { z } from "zod";
import { audit } from "@/lib/auth";
import { decideCandidate, MetaError } from "@/lib/meta/emergent";
import { ApiError, handle, jsonBody } from "@/lib/meta/http";

type Ctx = { params: Promise<{ table: string; id: string }> };
const params = z.object({ table: z.enum(["kinds", "relations", "attributes"]), id: z.uuid() });
const input = z.object({ action: z.enum(["accept", "hide", "merge", "restore"]), intoKey: z.string().trim().min(1).max(60).optional() });

/** POST /api/meta/candidates/{table}/{id} { action: accept | merge | hide | restore, intoKey? } — a person decides. */
export const POST = handle(async (req, v, ctx: Ctx) => {
  const p = params.safeParse(await ctx.params);
  if (!p.success) throw new ApiError(404, "Not found.");
  const body = await jsonBody(req, input);
  try {
    const r = await decideCandidate(v, { ...p.data, ...body });
    void audit(v, `meta.${body.action}`, { type: p.data.table, id: p.data.id }, { intoKey: body.intoKey ?? null }).catch(() => {});
    return r;
  } catch (e) {
    if (e instanceof MetaError) throw new ApiError(e.status, e.message);
    throw e;
  }
});
