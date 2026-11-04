/**
 * CONTRACT: the assistant's own work — suggestions inbox, activity log, automations/heartbeat, recipes, settings.
 * Owned by the automations workstream; signatures are fixed.
 * Everything is scoped to the viewer's current graph.
 *
 * Suggestion payloads (what approving writes; see ./policy for the schemas):
 *   reminder  { title, dueAt (ISO), detail?, aboutNodeId? }
 *   fact      { edgeId } to confirm an existing fact, or { fromId|from:{label,type}, relation, toId|to:{label,type}, sourceId?, quote?, confidence? }
 *   merge     { keepId, dropId }
 *   memory    { text, kind?, aboutNodeIds?, visibility?, quote?, sourceId? }      rule: same, saved as a family rule
 *   wiki_edit { title, text, slug? }  (appends to the page when slug exists, else creates it)
 *   nudge     { href?, label? }      (nothing is written)
 * dedupeKey: the same key is never proposed again once denied. "group#detail" keys replace older pending ones of the group.
 */
import type { Viewer } from "@/lib/auth";
import type { Citation } from "@/db/schema";
import { scopeOf } from "@/lib/graphs/pure";

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

/**
 * Capability "web" (search and read public pages for an answer). Default on for owners and parents, off for children
 * and guests; a person can switch it off in Assistant settings (`capabilities.web: false`). Children and guests stay
 * off even if the flag says on: what they ask must not leave the graph.
 */
export function webAllowed(v: Viewer, capabilities: Record<string, boolean> | undefined): boolean {
  const role = scopeOf(v).role;
  if (role !== "owner" && role !== "parent") return false;
  return (capabilities ?? {}).web !== false;
}

export type Recipe = { id: string; name: string; description: string; prompt: string; ownerId: string; visibility: "private" | "parents" | "household" };

/* Implementation lives in the helper files; they are loaded lazily so importing the contract stays light. */

export type ProposeOutcome = "created" | "existing" | "applied" | "denied" | "capped" | "refused";

/**
 * addSuggestion with the reason (used by check-ins to report what was held back). "applied" = the person chose
 * "Always allow" for this kind and the policy lets it apply without asking.
 */
export async function proposeSuggestion(input: SuggestionInput): Promise<{ id: string | null; outcome: ProposeOutcome }> {
  try {
    const { insertSuggestion, settingsFor, insertActivity, markDecidedById } = await import("./internal");
    const settings = await settingsFor(input.graphId, input.userId);
    const res = await insertSuggestion(input, settings.dailySuggestionCap);
    if ("refused" in res) return { id: null, outcome: res.refused === "invalid" ? "refused" : res.refused };
    if (!res.created) return { id: res.id, outcome: "existing" };
    const { autoApplies } = await import("./policy");
    const citesSources = (input.citations ?? []).some((c) => !!c.sourceId) || hasSourceId(input.payload);
    if (autoApplies(input.kind, input.origin, settings.alwaysAllow, { fromRun: !!input.runId, citesSources })) {
      const { viewerFor } = await import("@/lib/auth/viewer-for");
      const v = await viewerFor(input.userId, input.graphId);
      if (v) {
        const { applySuggestion } = await import("./apply");
        const { toSuggestionById } = await import("./internal");
        const s = await toSuggestionById(res.id);
        if (s && (await markDecidedById(v, res.id, "approved"))) {
          try {
            const r = await applySuggestion(v, s);
            await insertActivity({ graphId: input.graphId, userId: input.userId, actor: actorOf(input.origin), action: `applied_${input.kind}`,
              summary: `${r.label} (always allowed)`, subjectType: "suggestion", subjectId: res.id, runId: input.runId, conversationId: input.conversationId, visibility: "private" });
            return { id: res.id, outcome: "applied" };
          } catch {
            const { revertToPending } = await import("./internal");
            await revertToPending(res.id);
          }
        }
      }
    }
    // Suggestions made inside a run are listed with that run; only stand-alone ones get their own activity line.
    if (!input.runId) await insertActivity({
      graphId: input.graphId, userId: input.userId, actor: actorOf(input.origin), action: `suggested_${input.kind}`, summary: input.title,
      subjectType: "suggestion", subjectId: res.id, runId: input.runId, conversationId: input.conversationId, visibility: "private",
    });
    return { id: res.id, outcome: "created" };
  } catch (e) {
    console.error("[automations] addSuggestion failed:", e instanceof Error ? e.message : e);
    return { id: null, outcome: "refused" };
  }
}

function hasSourceId(payload: unknown): boolean {
  return !!payload && typeof payload === "object" && typeof (payload as { sourceId?: unknown }).sourceId === "string";
}

function actorOf(origin: Suggestion["origin"]): ActivityInput["actor"] {
  return origin === "chat" ? "chat" : origin === "heartbeat" ? "heartbeat" : origin === "ingest" ? "ingest" : "automation";
}

/** Proposes something for a person to approve. Respects the daily cap and never repeats a denied dedupeKey. */
export async function addSuggestion(input: SuggestionInput): Promise<string | null> {
  return (await proposeSuggestion(input)).id;
}

export async function listSuggestions(v: Viewer, opts: { status?: "pending" | "all"; limit?: number } = {}): Promise<Suggestion[]> {
  const { canUseAssistantTools } = await import("./policy");
  if (!canUseAssistantTools(v)) return [];
  const { selectSuggestions } = await import("./internal");
  return selectSuggestions(v, opts);
}

/** approve = apply it once; always = apply and add its action kind to alwaysAllow; deny = never show again. */
export async function decideSuggestion(v: Viewer, id: string, decision: "approve" | "always" | "deny"): Promise<{ ok: boolean; href?: string; label?: string }> {
  const { canUseAssistantTools, ACTION_KIND } = await import("./policy");
  const { AutomationError, ownSuggestion, markDecided, revertToPending, toSuggestion, insertActivity, addAlwaysAllow } = await import("./internal");
  if (!canUseAssistantTools(v)) throw new AutomationError(403, "Only parents can decide on the assistant's suggestions.");
  const row = await ownSuggestion(v, id);
  if (!row) throw new AutomationError(404, "That suggestion doesn't exist.");
  if (row.status !== "pending") {
    throw new AutomationError(409, row.status === "approved" ? "This was already approved." : row.status === "denied" ? "This was already dismissed." : "This suggestion has expired.");
  }
  const s = toSuggestion(row);
  if (decision === "deny") {
    if (!(await markDecided(v, id, "denied"))) throw new AutomationError(409, "This was already decided in another window.");
    await insertActivity({ graphId: v.graphId, userId: v.id, actor: actorOf(s.origin), action: "denied_suggestion", summary: `Dismissed: ${s.title}`,
      subjectType: "suggestion", subjectId: id, runId: s.runId ?? undefined, conversationId: s.conversationId ?? undefined, visibility: "private" });
    return { ok: true, label: "Dismissed." };
  }
  // Claim it first so a double click (or two tabs) can't apply it twice; undo the claim if applying fails.
  if (!(await markDecided(v, id, "approved"))) throw new AutomationError(409, "This was already decided in another window.");
  let result: { href?: string; label: string };
  try {
    const { applySuggestion } = await import("./apply");
    result = await applySuggestion(v, s);
  } catch (e) {
    await revertToPending(id);
    throw e;
  }
  if (decision === "always" && s.kind !== "nudge") await addAlwaysAllow(v.graphId, v.id, ACTION_KIND[s.kind]);
  await insertActivity({ graphId: v.graphId, userId: v.id, actor: actorOf(s.origin), action: `approved_${s.kind}`, summary: result.label,
    subjectType: "suggestion", subjectId: id, runId: s.runId ?? undefined, conversationId: s.conversationId ?? undefined, visibility: "private" });
  return { ok: true, ...result };
}

export async function logActivity(input: ActivityInput): Promise<void> {
  try {
    const { insertActivity } = await import("./internal");
    await insertActivity(input);
  } catch (e) {
    console.error("[automations] logActivity failed:", e instanceof Error ? e.message : e);
  }
}
export async function listActivity(v: Viewer, opts: { limit?: number; subjectId?: string; runId?: string } = {}): Promise<Activity[]> {
  const { canUseAssistantTools } = await import("./policy");
  if (!canUseAssistantTools(v)) return [];
  const { selectActivity } = await import("./internal");
  return selectActivity(v, opts);
}

export async function getAssistantSettings(v: Viewer): Promise<AssistantSettings> {
  try {
    const { settingsFor } = await import("./internal");
    return await settingsFor(v.graphId, v.id);
  } catch {
    return { ...DEFAULT_SETTINGS, capabilities: { ...DEFAULT_SETTINGS.capabilities } };
  }
}
/** True when the viewer chose "Always allow" for this action kind (e.g. "reminder.create"). */
export async function isAlwaysAllowed(v: Viewer, actionKind: string): Promise<boolean> {
  return (await getAssistantSettings(v)).alwaysAllow.includes(actionKind);
}

/** Adds an action kind to the viewer's "Always allow" list (from an approval card in chat or the inbox). */
export async function allowAlways(v: Viewer, actionKind: string): Promise<void> {
  const { canUseAssistantTools } = await import("./policy");
  if (!canUseAssistantTools(v)) return;
  const { addAlwaysAllow } = await import("./internal");
  await addAlwaysAllow(v.graphId, v.id, actionKind);
}

export async function listRecipes(v: Viewer): Promise<Recipe[]> {
  const { listRecipesFor } = await import("@/lib/recipes");
  return (await listRecipesFor(v)).map(({ id, name, description, prompt, ownerId, visibility }) => ({ id, name, description, prompt, ownerId, visibility }));
}

/** Starts the in-process scheduler (called once from instrumentation). Safe to call more than once. */
export function startScheduler(): void {
  void import("./scheduler").then((m) => m.start()).catch((e) => console.error("[automations] scheduler failed to start:", e instanceof Error ? e.message : e));
}
