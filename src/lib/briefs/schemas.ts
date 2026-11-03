/** Request validation for /api/reminders and /api/briefs (pure). */
import { z } from "zod";

const isoDate = z.iso.datetime({ offset: true, message: "Use an ISO date and time, e.g. 2026-11-04T08:00:00+01:00" });

const title = z.string().trim().min(1, "Give the reminder a title").max(200, "Keep the title under 200 characters");
const detail = z.string().trim().max(2000, "Keep the details under 2,000 characters");

export const reminderCreateSchema = z.object({
  title,
  detail: detail.nullish().transform((d) => (d ? d : null)),
  dueAt: isoDate.transform((s) => new Date(s)),
  aboutNodeId: z.uuid("aboutNodeId must be a node id").nullish().transform((v) => v ?? null),
}).strict();

export const reminderPatchSchema = z.object({
  title: title.optional(),
  detail: detail.nullable().optional().transform((d) => (d === undefined ? undefined : d ? d : null)),
  dueAt: isoDate.transform((s) => new Date(s)).optional(),
  done: z.boolean().optional(),
}).strict().refine((p) => Object.values(p).some((v) => v !== undefined), { message: "Nothing to change" });

const flag = z.enum(["1", "true", "0", "false", ""]).transform((v) => v === "1" || v === "true" || v === "");

export const reminderQuerySchema = z.object({
  /** Open reminders due within the next `days` days (overdue included). */
  upcoming: flag.optional(),
  days: z.coerce.number().int().min(1).max(366).default(14),
  /** Only reminders about this node (e.g. a child's person node). */
  about: z.uuid("about must be a node id").optional(),
  includeDone: flag.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export const reminderIdSchema = z.uuid("Unknown reminder");

export const briefRequestSchema = z.object({
  /** Ignore the cached brief and write a new one. */
  refresh: z.boolean().optional().default(false),
}).strict();

export type ReminderCreate = z.output<typeof reminderCreateSchema>;
export type ReminderPatch = z.output<typeof reminderPatchSchema>;
export type ReminderQuery = z.output<typeof reminderQuerySchema>;

/** First human-readable message from a zod error. */
export function firstIssue(err: z.ZodError): string {
  const i = err.issues[0];
  if (!i) return "Invalid request";
  const path = i.path.length ? `${i.path.join(".")}: ` : "";
  return `${path}${i.message}`;
}
