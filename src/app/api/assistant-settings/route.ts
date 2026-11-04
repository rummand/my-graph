import { getAssistantSettings } from "@/lib/automations";
import { parseJson, route, settingsPatchBody } from "@/lib/automations/http";
import { assistantUsage } from "@/lib/automations/overview";
import { writeSettings } from "@/lib/automations/store";

/** GET: my assistant settings in this graph, plus this week's usage. */
export const GET = route(async (_req, v) => ({ settings: await getAssistantSettings(v), usage: await assistantUsage(v) }));

/** PATCH any AssistantSettings fields, or { onboarded: true }. */
export const PATCH = route(async (req, v) => {
  const body = await parseJson(req, settingsPatchBody);
  return { settings: await writeSettings(v.graphId, v.id, body) };
});
