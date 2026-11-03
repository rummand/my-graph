/** zod schemas for the timeline API (GET /api/timeline). */
import { z } from "zod";
import type { ItemKind } from "./types";

const blank = (v: unknown) => (v === "" || v === null ? undefined : v);

/** "a,b,c" → ["a","b","c"] (also accepts repeated params joined by the route). */
const csv = <T extends z.ZodType>(item: T, max: number) =>
  z.preprocess(
    (v) => {
      if (v === undefined || v === null || v === "") return undefined;
      const s = Array.isArray(v) ? v.join(",") : String(v);
      const parts = s.split(",").map((x) => x.trim()).filter(Boolean);
      return parts.length ? [...new Set(parts)] : undefined;
    },
    z.array(item).max(max).optional(),
  );

const isoDate = z.preprocess(blank, z.iso.datetime({ offset: true, message: "Use an ISO date, e.g. 2024-03-01T00:00:00Z" })
  .or(z.iso.date({ message: "Use an ISO date, e.g. 2024-03-01" })).optional());

export const ITEM_KINDS = ["event", "reminder", "source"] as const satisfies readonly ItemKind[];

export const timelineQuerySchema = z.object({
  from: isoDate,
  to: isoDate,
  people: csv(z.uuid({ message: "people must be a list of person ids" }), 50),
  topics: csv(z.uuid({ message: "topics must be a list of topic ids" }), 50),
  /** Which kinds of marker to include. Default: events and reminders ("source" adds 'added to library' markers). */
  types: csv(z.enum(ITEM_KINDS, { message: "types can be event, reminder and source" }), 3),
  limit: z.preprocess(blank, z.coerce.number().int().min(1).max(2000).optional()),
}).refine((q) => !q.from || !q.to || new Date(q.from) <= new Date(q.to), { message: "from must be before to", path: ["from"] });

export type TimelineQueryInput = z.input<typeof timelineQuerySchema>;
export type TimelineQuery = z.output<typeof timelineQuerySchema>;

/** Query params → plain object (keeps repeated keys as arrays). */
export function searchParamsToObject(sp: URLSearchParams): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const key of new Set(sp.keys())) {
    const all = sp.getAll(key);
    out[key] = all.length > 1 ? all : all[0];
  }
  return out;
}
