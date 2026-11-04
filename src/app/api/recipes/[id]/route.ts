import { deleteRecipe, updateRecipe } from "@/lib/recipes";
import { parseId, parseJson, recipePatchBody, route } from "@/lib/automations/http";

type Ctx = { params: Promise<{ id: string }> };

export const PATCH = route<Ctx>(async (req, v, { params }) => {
  const id = parseId((await params).id, "That recipe");
  const body = await parseJson(req, recipePatchBody);
  return { recipe: await updateRecipe(v, id, body) };
}, { write: true });

export const DELETE = route<Ctx>(async (_req, v, { params }) => {
  await deleteRecipe(v, parseId((await params).id, "That recipe"));
  return { ok: true };
}, { write: true });
