import { parseBody, parseParam, route, uuid } from "@/lib/clinical/http";
import { editItem } from "@/lib/clinical";
import { itemPatch } from "@/lib/clinical/schemas";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };
const idOf = async (ctx: Ctx) => parseParam((await ctx.params).id, uuid);

/** PATCH: edit a draft (a new version; earlier ones stay in its history). */
export const PATCH = route<Ctx>(async (req, v, ctx) => {
  const { baseVersion, ...patch } = await parseBody(req, itemPatch);
  return { item: await editItem(v, await idOf(ctx), patch, baseVersion) };
});
