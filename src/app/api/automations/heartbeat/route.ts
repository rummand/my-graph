import { getHeartbeat, setHeartbeat } from "@/lib/automations/automations";
import { heartbeatBody, parseJson, route } from "@/lib/automations/http";

/** GET: my check-in in this graph (null until it is first switched on). */
export const GET = route(async (_req, v) => ({ heartbeat: await getHeartbeat(v) }));

/** PATCH { enabled?, config?: { everyMinutes, days, from, to, tz } } */
export const PATCH = route(async (req, v) => {
  const body = await parseJson(req, heartbeatBody);
  return { heartbeat: await setHeartbeat(v, body) };
}, { write: true });
