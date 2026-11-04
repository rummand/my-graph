import { parseBody, parseParam, route, uuid } from "@/lib/clinical/http";
import { updateConsent } from "@/lib/clinical";
import { consentPatch } from "@/lib/clinical/schemas";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };
const idOf = async (ctx: Ctx) => parseParam((await ctx.params).id, uuid);

/** PATCH: change a consent (kept in its history). */
export const PATCH = route<Ctx>(async (req, v, ctx) => {
  const b = await parseBody(req, consentPatch);
  await updateConsent(v, await idOf(ctx), { ...b, note: b.note === undefined ? undefined : b.note || null });
  return { ok: true };
});
