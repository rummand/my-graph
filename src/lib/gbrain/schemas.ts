/** zod schemas for the GBrain API boundary. */
import { z } from "zod";

export const nodeTypes = ["person", "place", "event", "topic", "document", "source"] as const;
export const visibilities = ["private", "parents", "household"] as const;
export const precisions = ["minute", "day", "month", "year"] as const;

const date = z.coerce.date({ message: "Not a valid date" });
const label = z.string().trim().min(1, "A name is required").max(200, "Keep the name under 200 characters");
const props = z.record(z.string(), z.unknown()).refine((p) => JSON.stringify(p).length <= 20_000, "Too much extra data");

export const nodeCreateSchema = z.object({
  type: z.enum(nodeTypes),
  label,
  aliases: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
  summary: z.string().trim().max(5000).optional(),
  props: props.optional(),
  startAt: date.nullable().optional(),
  endAt: date.nullable().optional(),
  timePrecision: z.enum(precisions).nullable().optional(),
  visibility: z.enum(visibilities).optional(),
  sensitive: z.boolean().optional(),
  note: z.string().trim().max(1000).optional(),
}).refine((n) => !n.startAt || !n.endAt || n.endAt >= n.startAt, { message: "The end can't be before the start", path: ["endAt"] });

export const nodePatchSchema = z.object({
  type: z.enum(nodeTypes).optional(),
  label: label.optional(),
  aliases: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
  summary: z.string().trim().max(5000).optional(),
  props: props.optional(),
  startAt: date.nullable().optional(),
  endAt: date.nullable().optional(),
  timePrecision: z.enum(precisions).nullable().optional(),
  visibility: z.enum(visibilities).optional(),
  sensitive: z.boolean().optional(),
  note: z.string().trim().max(1000).optional(),
}).refine((p) => Object.keys(p).some((k) => k !== "note"), { message: "Nothing to change" });

export const edgePatchSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("confirm"), note: z.string().trim().max(1000).optional() }),
  z.object({ action: z.literal("reject"), note: z.string().trim().max(1000).optional() }),
  z.object({
    action: z.literal("correct"),
    relation: z.string().trim().min(1).max(80).optional(),
    fromId: z.uuid().optional(),
    toId: z.uuid().optional(),
    note: z.string().trim().max(1000).optional(),
  }).refine((c) => c.relation || c.fromId || c.toId, { message: "Say what the correct fact is" }),
]);

export const mergeSchema = z.object({ dropId: z.uuid({ message: "Pick the item to merge in" }) });
export const dismissSchema = z.object({ aId: z.uuid(), bId: z.uuid() }).refine((d) => d.aId !== d.bId, { message: "Pick two different items" });
