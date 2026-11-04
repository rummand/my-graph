/** Data for the /automations page and the usage line (server-only). */
import type { Viewer } from "@/lib/auth";
import { listActivity, listSuggestions, getAssistantSettings, type Activity, type AssistantSettings, type Suggestion } from "./index";
import { getHeartbeat, listAutomations, runsSince, type AutomationDTO } from "./automations";
import { canCreateAssistantWork } from "./policy";
import { suggestionStats } from "./store";
import { listRecipesFor, type RecipeDTO } from "@/lib/recipes";

export type Usage = { runs: number; suggestions: number; approved: number; denied: number };

export async function assistantUsage(v: Viewer, now = new Date()): Promise<Usage> {
  const since = new Date(now.getTime() - 7 * 24 * 3600_000);
  const [runs, s] = await Promise.all([runsSince(v, since), suggestionStats(v, since)]);
  return { runs, suggestions: s.total, approved: s.approved, denied: s.denied };
}

export type AutomationsPageData = {
  canCreate: boolean; heartbeat: AutomationDTO | null; automations: AutomationDTO[]; recipes: RecipeDTO[];
  activity: (Omit<Activity, "createdAt"> & { createdAt: string })[]; suggestions: (Omit<Suggestion, "createdAt"> & { createdAt: string })[];
  settings: Omit<AssistantSettings, "onboardedAt"> & { onboardedAt: string | null }; usage: Usage; graphName: string;
};

export async function loadAutomationsPage(v: Viewer): Promise<AutomationsPageData> {
  const [heartbeat, automations, recipes, activity, suggestions, settings, usage] = await Promise.all([
    getHeartbeat(v), listAutomations(v), listRecipesFor(v, { seed: true }), listActivity(v, { limit: 40 }),
    listSuggestions(v, { status: "pending", limit: 30 }), getAssistantSettings(v), assistantUsage(v),
  ]);
  return {
    canCreate: canCreateAssistantWork(v), heartbeat, automations, recipes, usage, graphName: v.graphName,
    activity: activity.filter((a) => a.action !== "seeded_recipes").map((a) => ({ ...a, createdAt: a.createdAt.toISOString() })),
    suggestions: suggestions.map((s) => ({ ...s, createdAt: s.createdAt.toISOString() })),
    settings: { ...settings, onboardedAt: settings.onboardedAt?.toISOString() ?? null },
  };
}
