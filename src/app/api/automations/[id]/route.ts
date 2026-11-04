import { deleteAutomation, getAutomation, updateAutomation } from "@/lib/automations/automations";
import { automationPatchBody, parseId, parseJson, route } from "@/lib/automations/http";

type Ctx = { params: Promise<{ id: string }> };

export const GET = route<Ctx>(async (_req, v, { params }) => ({ automation: await getAutomation(v, parseId((await params).id, "That automation")) }));

/** PATCH any of { name, prompt, recipeId, trigger, config, oneShot, enabled } */
export const PATCH = route<Ctx>(async (req, v, { params }) => {
  const id = parseId((await params).id, "That automation");
  const body = await parseJson(req, automationPatchBody);
  return { automation: await updateAutomation(v, id, body) };
}, { write: true });

export const DELETE = route<Ctx>(async (_req, v, { params }) => {
  await deleteAutomation(v, parseId((await params).id, "That automation"));
  return { ok: true };
}, { write: true });
