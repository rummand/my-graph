import { z } from "zod";

export const visibility = z.enum(["private", "parents", "household"]);
const kindKey = z.string().trim().regex(/^[a-z][a-z0-9_]{0,47}$/, "Pick a kind from the list");
const props = z.record(z.string().max(48), z.union([z.string().max(10000), z.number(), z.boolean(), z.null()]));

export const createPersonBody = z.object({
  label: z.string().trim().min(1, "Give them a name").max(120),
  kind: kindKey.nullable(),
  visibility: visibility.optional(),
  sensitive: z.boolean().optional(),
  props: props.optional(),
  relation: z.object({ key: kindKey, direction: z.enum(["out", "in"]), otherId: z.uuid() }).nullish(),
});

export const updatePersonBody = z.object({
  label: z.string().trim().min(1, "Give them a name").max(120).optional(),
  kind: kindKey.nullable().optional(),
  visibility: visibility.optional(),
  sensitive: z.boolean().optional(),
  props: props.optional(),
  summary: z.string().max(5000).nullable().optional(),
  aliases: z.array(z.string().trim().min(1).max(120)).max(20).optional(),
}).refine((b) => Object.keys(b).length > 0, "Nothing to change");

export const observationBody = z.object({
  kind: z.enum(["wellbeing", "health", "milestone", "contact", "note"]),
  score: z.number().int().min(1).max(5).nullish(),
  note: z.string().trim().max(4000).nullish(),
  tags: z.array(z.string().trim().min(1).max(40)).max(12).optional(),
  at: z.iso.datetime({ offset: true }).or(z.iso.date()).optional(),
  visibility: visibility.optional(),
  sensitive: z.boolean().optional(),
}).refine((b) => b.kind !== "wellbeing" || b.score != null, { message: "Pick how they are, from 1 to 5", path: ["score"] })
  .refine((b) => b.kind === "wellbeing" || b.kind === "contact" || !!b.note, { message: "Write a few words", path: ["note"] });

export const relationBody = z.object({
  relation: kindKey,
  direction: z.enum(["out", "in"]),
  otherId: z.uuid().optional(),
  newPerson: z.object({ label: z.string().trim().min(1).max(120), kind: kindKey.nullable(), visibility: visibility.optional() }).optional(),
}).refine((b) => !!b.otherId !== !!b.newPerson, "Pick someone or add a new person");
