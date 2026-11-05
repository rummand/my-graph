import { z } from "zod";
import { search } from "@/lib/search";
import { isSection } from "@/lib/search/types";
import { ApiError, handle } from "@/lib/meta/http";

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional();
const query = z.object({
  q: z.string().max(200).default(""),
  types: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
  offset: z.coerce.number().int().min(0).max(1000).optional(),
  mode: z.enum(["quick", "full"]).default("quick"),
  owner: z.enum(["me", "others"]).optional(),
  from: day,
  to: day,
  folder: z.string().uuid().optional(),
  sort: z.enum(["relevance", "newest"]).optional(),
});

/**
 * GET /api/search?q=&types=nodes,files&limit=&offset=&mode=quick|full&owner=me|others&from=YYYY-MM-DD&to=&folder=&sort=
 * Everything in the current graph the viewer may read, grouped by section with a top hit. `quick` is the ⌘K palette
 * (keyword only, small caps); `full` is /search (adds meaning-based results when mux is up, paging per section).
 */
export const GET = handle(async (req, v) => {
  const r = query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!r.success) throw new ApiError(400, "Invalid search.");
  const d = r.data;
  const types = d.types?.split(",").filter(isSection);
  const to = d.to ? new Date(`${d.to}T00:00:00Z`) : null;
  if (to) to.setUTCDate(to.getUTCDate() + 1);
  const out = await search(v, {
    q: d.q, types, limit: d.limit, offset: d.offset, mode: d.mode, owner: d.owner ?? null,
    from: d.from ? new Date(`${d.from}T00:00:00Z`) : null, to, folder: d.folder ?? null, sort: d.sort,
  });
  return Response.json(out, { headers: { "cache-control": "no-store", "server-timing": `search;dur=${out.ms}` } });
});
