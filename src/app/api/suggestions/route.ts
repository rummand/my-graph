import { listSuggestions } from "@/lib/automations";
import { parseQuery, route, suggestionsQuery } from "@/lib/automations/http";

/** GET ?status=pending|all&limit= : the assistant's suggestions waiting for me in this graph. */
export const GET = route(async (req, v) => {
  const q = parseQuery(req, suggestionsQuery);
  return { suggestions: await listSuggestions(v, q) };
});
