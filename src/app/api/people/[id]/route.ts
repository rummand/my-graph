import { personProfile, updatePerson } from "@/lib/people";
import { body, HttpError, route, uuid } from "@/lib/people/http";
import { updatePersonBody } from "../schemas";

type Ctx = { params: Promise<{ id: string }> };
async function idOf(ctx: Ctx) {
  const r = uuid.safeParse((await ctx.params).id);
  if (!r.success) throw new HttpError(404, "Person not found");
  return r.data;
}

/** GET /api/people/:id — profile: attributes from the meta model, relationships, observations, feed. */
export const GET = route(async (_req, v, ctx: Ctx) => {
  const p = await personProfile(v, await idOf(ctx));
  if (!p) throw new HttpError(404, "Person not found");
  return p;
});

/** PATCH /api/people/:id — label, kind, visibility, props (validated against the meta model; "" or null removes). */
export const PATCH = route(async (req, v, ctx: Ctx) => {
  const id = await idOf(ctx);
  const b = await body(req, updatePersonBody);
  await updatePerson(v, id, b);
  return personProfile(v, id);
});
