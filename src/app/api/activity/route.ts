import { listActivity } from "@/lib/automations";
import { activityQuery, parseQuery, route } from "@/lib/automations/http";

/** GET ?limit=&subjectId=&runId= : what the assistant did in this graph, newest first, that I may see. */
export const GET = route(async (req, v) => {
  const q = parseQuery(req, activityQuery);
  return { activity: await listActivity(v, q) };
});
