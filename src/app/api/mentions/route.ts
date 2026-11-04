import { z } from "zod";
import { searchMentionables } from "@/lib/mentions";
import { ApiError, handle } from "@/lib/meta/http";

const TYPES = ["person", "place", "event", "topic", "document", "source", "organization", "project", "thing"] as const;
const query = z.object({ q: z.string().max(60).default(""), types: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(20).optional() });

/** GET /api/mentions?q=&types=person,project — the @ typeahead over everything in the current graph the viewer can see. */
export const GET = handle(async (req, v) => {
  const r = query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!r.success) throw new ApiError(400, "Invalid query.");
  const types = r.data.types?.split(",").filter((t): t is (typeof TYPES)[number] => (TYPES as readonly string[]).includes(t));
  return { items: await searchMentionables(v, r.data.q, { limit: r.data.limit, types }) };
});
