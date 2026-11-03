import { z } from "zod";
import { addObservation, listObservations, visibleNode } from "@/lib/people";
import { body, HttpError, query, route, uuid } from "@/lib/people/http";
import { observationBody } from "../../schemas";

type Ctx = { params: Promise<{ id: string }> };
async function idOf(ctx: Ctx) {
  const r = uuid.safeParse((await ctx.params).id);
  if (!r.success) throw new HttpError(404, "Person not found");
  return r.data;
}

/** GET /api/people/:id/observations?kind=wellbeing&limit=50 */
export const GET = route(async (req, v, ctx: Ctx) => {
  const id = await idOf(ctx);
  const q = query(req, z.object({
    kind: z.enum(["wellbeing", "health", "milestone", "contact", "note"]).optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
  }));
  if (!(await visibleNode(v, id))) throw new HttpError(404, "Person not found");
  return { observations: await listObservations(v, id, q) };
});

/** POST /api/people/:id/observations — a check-in (1–5), contact moment, milestone, health note or note. */
export const POST = route(async (req, v, ctx: Ctx) => {
  const id = await idOf(ctx);
  const b = await body(req, observationBody);
  const row = await addObservation(v, id, { ...b, at: b.at ? new Date(b.at) : undefined });
  return Response.json({ observation: row }, { status: 201 });
});
