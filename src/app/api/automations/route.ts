import { createAutomation, getHeartbeat, listAutomations } from "@/lib/automations/automations";
import { automationCreateBody, parseJson, route } from "@/lib/automations/http";

/** GET: my automations in this graph, and my check-in. */
export const GET = route(async (_req, v) => ({ automations: await listAutomations(v), heartbeat: await getHeartbeat(v) }));

/** POST { name, prompt? | recipeId?, trigger: "schedule"|"condition", config, oneShot?, enabled? } */
export const POST = route(async (req, v) => {
  const body = await parseJson(req, automationCreateBody);
  const automation = await createAutomation(v, body);
  return Response.json({ automation }, { status: 201 });
}, { write: true });
