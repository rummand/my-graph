/**
 * CONTRACT: the assistant's own work — suggestions inbox, activity log, automations/heartbeat, recipes, settings.
 * Owned by the automations workstream; signatures are fixed, bodies are stubs until it lands.
 * Everything is scoped to the viewer's current graph.
 */
import type { Viewer } from "@/lib/auth";
import type { Citation } from "@/db/schema";

export type SuggestionKind = "fact" | "reminder" | "merge" | "rule" | "memory" | "wiki_edit" | "nudge";
export type Suggestion = {
  id: string; kind: SuggestionKind; title: string; body: string | null; payload: Record<string, unknown>;
  citations: Citation[]; origin: "chat" | "automation" | "heartbeat" | "ingest"; runId: string | null;
  conversationId: string | null; status: "pending" | "approved" | "denied" | "expired"; createdAt: Date;
};
export type SuggestionInput = Omit<Suggestion, "id" | "status" | "createdAt" | "runId" | "conversationId" | "citations"> & {
  graphId: string; userId: string; runId?: string; conversationId?: string; citations?: Citation[]; dedupeKey?: string;
};

export type Activity = {
  id: string; actor: string; action: string; summary: string; subjectType: string | null; subjectId: string | null;
  runId: string | null; conversationId: string | null; createdAt: Date;
};
export type ActivityInput = {
  graphId: string; userId?: string | null; actor: "chat" | "automation" | "heartbeat" | "ingest" | "wiki"; action: string; summary: string;
  subjectType?: string; subjectId?: string; runId?: string; conversationId?: string; visibility?: "private" | "parents" | "household";
};

export type AssistantSettings = {
  autoSaveMemories: boolean; alwaysAllow: string[]; capabilities: Record<string, boolean>;
  tone: "warm" | "brief" | "detailed"; dailySuggestionCap: number; onboardedAt: Date | null;
};
export const DEFAULT_SETTINGS: AssistantSettings = {
  autoSaveMemories: true, alwaysAllow: [], capabilities: { library: true, timeline: true, people: true, wiki_write: true, reminders: true },
  tone: "warm", dailySuggestionCap: 5, onboardedAt: null,
};

export type Recipe = { id: string; name: string; description: string; prompt: string; ownerId: string; visibility: "private" | "parents" | "household" };

/** Proposes something for a person to approve. Respects the daily cap and never repeats a denied dedupeKey. */
export async function addSuggestion(_input: SuggestionInput): Promise<string | null> {
  return null;
}
export async function listSuggestions(_v: Viewer, _opts: { status?: "pending" | "all"; limit?: number } = {}): Promise<Suggestion[]> {
  return [];
}
/** approve = apply it once; always = apply and add its action kind to alwaysAllow; deny = never show again. */
export async function decideSuggestion(_v: Viewer, _id: string, _decision: "approve" | "always" | "deny"): Promise<{ ok: boolean; href?: string; label?: string }> {
  return { ok: false };
}

export async function logActivity(_input: ActivityInput): Promise<void> {}
export async function listActivity(_v: Viewer, _opts: { limit?: number; subjectId?: string; runId?: string } = {}): Promise<Activity[]> {
  return [];
}

export async function getAssistantSettings(_v: Viewer): Promise<AssistantSettings> {
  return DEFAULT_SETTINGS;
}
/** True when the viewer chose "Always allow" for this action kind (e.g. "reminder.create"). */
export async function isAlwaysAllowed(v: Viewer, actionKind: string): Promise<boolean> {
  return (await getAssistantSettings(v)).alwaysAllow.includes(actionKind);
}

/** Adds an action kind to the viewer's "Always allow" list (from an approval card in chat or the inbox). */
export async function allowAlways(_v: Viewer, _actionKind: string): Promise<void> {}

export async function listRecipes(_v: Viewer): Promise<Recipe[]> {
  return [];
}

/** Starts the in-process scheduler (called once from instrumentation). Safe to call more than once. */
export function startScheduler(): void {}
