import { z } from "zod";
import { audit } from "@/lib/auth";
import { hideBuiltin, inputs, upsert } from "@/lib/meta/admin";
import { META_NODE_TYPES } from "@/lib/meta/types";
import { body, HttpError, requireParent, route } from "@/lib/people/http";

const table = z.enum(["kinds", "relations", "attributes"]);
type Ctx = { params: Promise<{ table: string }> };

const hideInput = z.object({
  hidden: z.literal(true),
  key: z.string().min(1).max(48),
  nodeType: z.enum(META_NODE_TYPES as [string, ...string[]]).optional(),
  kindKey: z.string().max(48).nullish(),
});

/**
 * POST /api/meta/{kinds|relations|attributes} — parents only.
 * Body = the row (creates the household's version; same key as a built-in = override), or
 * `{ hidden: true, key, nodeType?, kindKey? }` to hide a built-in for this household.
 */
export const POST = route(async (req, v, ctx: Ctx) => {
  requireParent(v);
  const t = table.safeParse((await ctx.params).table);
  if (!t.success) throw new HttpError(404, "Unknown meta table");
  const raw = await body(req, z.record(z.string(), z.unknown()));
  if (raw.hidden === true) {
    const h = hideInput.parse(raw);
    if (t.data !== "relations" && !h.nodeType) throw new HttpError(400, "nodeType is required");
    const row = await hideBuiltin(v.householdId, t.data, h);
    if (!row) throw new HttpError(404, "There's no built-in with that key");
    void audit(v, "meta.hide", { type: t.data, id: row.id }, { key: h.key }).catch(() => {});
    return { row };
  }
  const parsed = inputs[t.data].safeParse(raw);
  if (!parsed.success) throw new HttpError(400, "Some fields need fixing", { fields: parsed.error.issues.map((i) => ({ key: i.path.join("."), message: i.message })) });
  const row = await (upsert[t.data] as (hh: string, input: unknown) => Promise<{ id: string }>)(v.householdId, parsed.data);
  void audit(v, "meta.save", { type: t.data, id: row.id }, {}).catch(() => {});
  return Response.json({ row }, { status: 201 });
});
