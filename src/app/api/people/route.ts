import { z } from "zod";
import { createPerson, peopleOverview } from "@/lib/people";
import { body, query, route } from "@/lib/people/http";
import { createPersonBody } from "./schemas";

/** GET /api/people?center=<personId> — the overview: people, circles, relation to the centre, attention list. */
export const GET = route(async (req, v) => {
  const q = query(req, z.object({ center: z.uuid().optional() }));
  return peopleOverview(v, { centerId: q.center ?? null });
});

/** POST /api/people — add a person (and optionally how they relate to someone). */
export const POST = route(async (req, v) => {
  const b = await body(req, createPersonBody);
  const r = await createPerson(v, { ...b, props: b.props ?? {}, relation: b.relation ?? null });
  return Response.json(r, { status: r.created ? 201 : 200 });
});
