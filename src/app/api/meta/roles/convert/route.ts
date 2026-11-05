import { audit } from "@/lib/auth";
import { previewRoleConversion, proposeRoleConversion } from "@/lib/meta/convert-roles";
import { getLocale } from "@/lib/i18n";
import { getMeta } from "@/lib/meta";
import { MetaError } from "@/lib/meta/emergent";
import { ApiError, handle } from "@/lib/meta/http";

/** GET /api/meta/roles/convert — what turning kinds into roles would propose in the current graph (nothing is written). */
export const GET = handle(async (_req, v) => {
  const [plan, meta, locale] = await Promise.all([previewRoleConversion(v), getMeta(v), getLocale()]);
  const keys = new Set(plan.items.flatMap((i) => (i.role ? [i.role] : [])));
  const roleNames = Object.fromEntries([...keys].map((k) => [k, meta.roleWords(k, locale).label.toLowerCase()]));
  return { counts: plan.counts, items: plan.items.slice(0, 200), roleNames };
});

/** POST /api/meta/roles/convert — propose it as one change set a person delivers. */
export const POST = handle(async (_req, v) => {
  try {
    const r = await proposeRoleConversion(v);
    if (r.changeSetId) void audit(v, "meta.roles.convert", { type: "change_set", id: r.changeSetId }, { ...r.plan.counts }).catch(() => {});
    return { changeSetId: r.changeSetId, counts: r.plan.counts };
  } catch (e) {
    if (e instanceof MetaError) throw new ApiError(e.status, e.message);
    throw e;
  }
});
