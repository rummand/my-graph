import { addRelation } from "@/lib/people";
import { body, HttpError, route, uuid } from "@/lib/people/http";
import { relationBody } from "../../schemas";

type Ctx = { params: Promise<{ id: string }> };

/** POST /api/people/:id/relations — relate this person to someone (existing, or a new person created on the fly). */
export const POST = route(async (req, v, ctx: Ctx) => {
  const r = uuid.safeParse((await ctx.params).id);
  if (!r.success) throw new HttpError(404, "Person not found");
  const b = await body(req, relationBody);
  return Response.json(await addRelation(v, r.data, b), { status: 201 });
});
