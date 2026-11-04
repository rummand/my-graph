import { z } from "zod";
import { audit } from "@/lib/auth";
import { addFact } from "@/lib/profile";
import { jsonOf, nodeParams, profileRoute } from "@/lib/profile/http";

type Ctx = { params: Promise<{ id: string }> };
const key = z.string().trim().min(1).max(60).regex(/^[a-z0-9_]+$/, "Use letters, digits and _");
const types = z.enum(["person", "organization", "project", "place", "event", "topic", "thing"]);
const schema = z.object({
  relation: key,
  direction: z.enum(["out", "in"]),
  other: z.union([
    z.object({ id: z.uuid() }).strict(),
    z.object({ label: z.string().trim().min(1).max(120), type: types, kind: key.nullable(), kindLabel: z.string().trim().max(60).nullish() }).strict(),
  ]),
  relationDef: z.object({
    label: z.string().trim().min(1).max(60), inverseLabel: z.string().trim().min(1).max(60), category: z.string().trim().max(30),
    fromTypes: z.array(z.string().max(30)).max(9), toTypes: z.array(z.string().max(30)).max(9),
  }).strict().optional(),
  kindDef: z.object({ label: z.string().trim().min(1).max(60), pluralLabel: z.string().trim().min(1).max(80) }).strict().optional(),
  note: z.string().trim().max(300).optional(),
}).strict();

/**
 * POST /api/profile/:id/facts { relation, direction, other, relationDef?, kindDef? } → { status, changeSetId, otherId, edgeId }.
 * A fact written on the profile: a change set the person authors and delivers at once ("delivered"), or, when it
 * needs someone else's decision, a proposal ("proposed").
 */
export const POST = profileRoute<Ctx>(async (req, v, ctx) => {
  const { id } = nodeParams.parse(await ctx.params);
  const input = await jsonOf(req, schema);
  const r = await addFact(v, id, input);
  void audit(v, "profile.fact", { type: "change_set", id: r.changeSetId }, { status: r.status, nodeId: id }).catch(() => {});
  return r;
});
