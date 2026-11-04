/**
 * The assistant's part of Today, loaded on the server through the automations contract (suggestions inbox, activity,
 * recipes, settings). Every call is scoped to the viewer's current graph by that contract; children and guests get
 * nothing. Each part loads on its own, so a failure (or the contract still being a stub) never blanks the page.
 * Server-only.
 */
import type { Viewer } from "@/lib/auth";
import {
  listActivity, listRecipes, listSuggestions, getAssistantSettings, DEFAULT_SETTINGS,
  type Activity, type AssistantSettings, type Recipe, type Suggestion,
} from "@/lib/automations";
import { canUseAssistantTools } from "./assistant-home";

export type AssistantHome = {
  /** False for children and guests: the page shows none of the assistant's tools. */
  enabled: boolean;
  suggestions: Suggestion[] | null;
  activity: Activity[] | null;
  recipes: Recipe[] | null;
  settings: AssistantSettings;
  /** Whether settings actually loaded (when false, never show first-run as if it were new). */
  settingsLoaded: boolean;
};

async function safe<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    console.error(`[today] ${name} failed:`, err);
    return null;
  }
}

export async function loadAssistantHome(v: Viewer): Promise<AssistantHome> {
  if (!canUseAssistantTools(v)) {
    return { enabled: false, suggestions: [], activity: [], recipes: [], settings: DEFAULT_SETTINGS, settingsLoaded: false };
  }
  const [suggestions, activity, recipes, settings] = await Promise.all([
    safe("suggestions", () => listSuggestions(v, { status: "pending", limit: 20 })),
    safe("activity", () => listActivity(v, { limit: 5 })),
    safe("recipes", () => listRecipes(v)),
    safe("assistant settings", () => getAssistantSettings(v)),
  ]);
  return {
    enabled: true,
    suggestions: suggestions?.filter((s) => s.status === "pending") ?? null,
    activity, recipes,
    settings: settings ?? DEFAULT_SETTINGS,
    settingsLoaded: settings !== null,
  };
}

/** Pending suggestions and the latest check-in, for the brief's background (empty for children and guests). */
export async function loadAssistantBriefInput(v: Viewer): Promise<{ pending: { title: string }[]; heartbeat: { summary: string; createdAt: Date } | null }> {
  if (!canUseAssistantTools(v)) return { pending: [], heartbeat: null };
  const [pending, activity] = await Promise.all([
    safe("suggestions", () => listSuggestions(v, { status: "pending", limit: 20 })),
    safe("activity", () => listActivity(v, { limit: 30 })),
  ]);
  const hb = (activity ?? []).filter((a) => a.actor === "heartbeat").sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt))[0];
  return {
    pending: (pending ?? []).filter((s) => s.status === "pending").map((s) => ({ title: s.title })),
    heartbeat: hb ? { summary: hb.summary, createdAt: new Date(hb.createdAt) } : null,
  };
}
