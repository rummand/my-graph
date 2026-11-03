import { z } from "zod";
import { audit } from "@/lib/auth";
import { getHouseholdRow, isTombstone } from "@/lib/meta";
import { deleteHouseholdRow, inputs, upsert, usageCount } from "@/lib/meta/admin";
import { body, HttpError, requireParent, route, uuid } from "@/lib/people/http";

const table = z.enum(["kinds", "relations", "attributes"]);
type Ctx = { params: Promise<{ table: string; id: string }> };

async function target(ctx: Ctx) {
  const p = await ctx.params;
  const t = table.safeParse(p.table);
  const id = uuid.safeParse(p.id);
  if (!t.success || !id.success) throw new HttpError(404, "Not found");
  return { table: t.data, id: id.data };
}

/** PATCH /api/meta/{table}/{id} — change one of the household's own rows (keys can't change). Parents only. */
export const PATCH = route(async (req, v, ctx: Ctx) => {
  requireParent(v);
  const { table: t, id } = await target(ctx);
  const row = await getHouseholdRow(t, v.householdId, id);
  if (!row || isTombstone(row)) throw new HttpError(404, "Only your household's own entries can be changed. Edit a built-in to create your version of it.");
  const patch = await body(req, z.record(z.string(), z.unknown()));
  delete patch.key; delete patch.nodeType; delete patch.kindKey; delete patch.householdId; delete patch.id; delete patch.builtin;
  const { id: _i, householdId: _h, createdAt: _c, builtin: _b, ...current } = row as Record<string, unknown>;
  const parsed = inputs[t].safeParse({ ...current, ...patch });
  if (!parsed.success) throw new HttpError(400, "Some fields need fixing", { fields: parsed.error.issues.map((i) => ({ key: i.path.join("."), message: i.message })) });
  const saved = await (upsert[t] as (hh: string, input: unknown) => Promise<{ id: string }>)(v.householdId, parsed.data);
  void audit(v, "meta.save", { type: t, id: saved.id }, {}).catch(() => {});
  return { row: saved };
});

/** DELETE /api/meta/{table}/{id} — remove an addition, or restore a built-in (deletes the override/hide). Parents only. */
export const DELETE = route(async (_req, v, ctx: Ctx) => {
  requireParent(v);
  const { table: t, id } = await target(ctx);
  const row = await deleteHouseholdRow(v.householdId, t, id);
  if (!row) throw new HttpError(404, "Not found");
  const inUse = await usageCount(v.householdId, t, row as { nodeType?: string; key: string });
  void audit(v, "meta.delete", { type: t, id }, { key: (row as { key: string }).key }).catch(() => {});
  return { deleted: true, inUse };
});
