/**
 * Automations and their runs (server-only). An automation belongs to one person in one graph and runs as them;
 * only they see it and its runs. Children and guests can't use automations; graph viewers can look but not create.
 */
import { and, asc, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { automationRuns, automations, recipeRuns, recipes } from "@/db/schema";
import type { Viewer } from "@/lib/auth";
import type { AssistantStep, Citation } from "@/db/schema";
import { canSeeRecipe } from "@/lib/recipes/pure";
import { canCreateAssistantWork, canUseAssistantTools } from "./policy";
import {
  DEFAULT_TZ, describeTrigger, nextRun, safeParseTrigger, type ParsedTrigger, type TriggerKind,
} from "./schedule";
import { AutomationError, selectSuggestions } from "./store";

type AutomationRow = typeof automations.$inferSelect;
type RunRow = typeof automationRuns.$inferSelect;
type RecipeRunRow = typeof recipeRuns.$inferSelect;

export type RunDTO = {
  id: string; source: "automation" | "recipe"; parentId: string; name: string;
  status: "running" | "done" | "failed" | "skipped"; startedAt: string; finishedAt: string | null;
  summary: string | null; output: string | null; citations: Citation[]; steps: AssistantStep[]; skipped: string[];
  suggestionCount: number; error: string | null;
};

export type AutomationDTO = {
  id: string; name: string; prompt: string; recipeId: string | null; trigger: TriggerKind; config: Record<string, unknown>;
  oneShot: boolean; enabled: boolean; nextRunAt: string | null; lastRunAt: string | null; createdAt: string;
  description: string; lastRun: Pick<RunDTO, "id" | "status" | "summary" | "startedAt" | "suggestionCount" | "error"> | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assertCanUse(v: Viewer): void {
  if (!canUseAssistantTools(v)) throw new AutomationError(403, "The assistant's automations are for parents.");
}
export function assertCanCreate(v: Viewer): void {
  assertCanUse(v);
  if (!canCreateAssistantWork(v)) throw new AutomationError(403, "You can look at this graph but not set up automations in it.");
}

export function runDTO(r: RunRow, name: string): RunDTO {
  return {
    id: r.id, source: "automation", parentId: r.automationId, name, status: r.status, startedAt: r.startedAt.toISOString(),
    finishedAt: r.finishedAt?.toISOString() ?? null, summary: r.summary, output: r.output, citations: r.citations ?? [],
    steps: r.steps ?? [], skipped: r.skipped ?? [], suggestionCount: r.suggestionCount, error: r.error,
  };
}
export function recipeRunDTO(r: RecipeRunRow, name: string): RunDTO {
  return {
    id: r.id, source: "recipe", parentId: r.recipeId, name, status: r.status, startedAt: r.startedAt.toISOString(),
    finishedAt: r.finishedAt?.toISOString() ?? null, summary: r.summary, output: r.output, citations: r.citations ?? [],
    steps: r.steps ?? [], skipped: r.skipped ?? [], suggestionCount: r.suggestionCount, error: r.error,
  };
}

function toDTO(a: AutomationRow, last: RunRow | undefined): AutomationDTO {
  const t = safeParseTrigger(a.trigger, a.config);
  return {
    id: a.id, name: a.name, prompt: a.prompt, recipeId: a.recipeId, trigger: a.trigger, config: a.config ?? {}, oneShot: a.oneShot,
    enabled: a.enabled, nextRunAt: a.enabled ? a.nextRunAt?.toISOString() ?? null : null, lastRunAt: a.lastRunAt?.toISOString() ?? null,
    createdAt: a.createdAt.toISOString(), description: t ? describeTrigger(t) : "Settings need fixing",
    lastRun: last ? { id: last.id, status: last.status, summary: last.summary, startedAt: last.startedAt.toISOString(), suggestionCount: last.suggestionCount, error: last.error } : null,
  };
}

const own = (v: Viewer) => and(eq(automations.graphId, v.graphId), eq(automations.ownerId, v.id));

async function lastRuns(ids: string[]): Promise<Map<string, RunRow>> {
  if (!ids.length) return new Map();
  const rows = await db.selectDistinctOn([automationRuns.automationId]).from(automationRuns)
    .where(inArray(automationRuns.automationId, ids)).orderBy(automationRuns.automationId, desc(automationRuns.startedAt));
  return new Map(rows.map((r) => [r.automationId, r]));
}

export async function listAutomations(v: Viewer, opts: { includeHeartbeat?: boolean } = {}): Promise<AutomationDTO[]> {
  assertCanUse(v);
  const rows = await db.select().from(automations).where(own(v)).orderBy(asc(automations.createdAt));
  const list = opts.includeHeartbeat ? rows : rows.filter((r) => r.trigger !== "heartbeat");
  const last = await lastRuns(list.map((r) => r.id));
  return list.map((r) => toDTO(r, last.get(r.id)));
}

export async function ownAutomationRow(v: Viewer, id: string): Promise<AutomationRow> {
  assertCanUse(v);
  if (!UUID.test(id)) throw new AutomationError(404, "That automation doesn't exist.");
  const [a] = await db.select().from(automations).where(and(own(v), eq(automations.id, id))).limit(1);
  if (!a) throw new AutomationError(404, "That automation doesn't exist.");
  return a;
}

export async function getAutomation(v: Viewer, id: string): Promise<AutomationDTO> {
  const a = await ownAutomationRow(v, id);
  return toDTO(a, (await lastRuns([a.id])).get(a.id));
}

/** A recipe the viewer may see in this graph (owner, household, or parents-only for parents). */
export async function visibleRecipe(v: Viewer, id: string): Promise<typeof recipes.$inferSelect | null> {
  if (!UUID.test(id)) return null;
  const [r] = await db.select().from(recipes).where(and(eq(recipes.id, id), eq(recipes.graphId, v.graphId))).limit(1);
  if (!r) return null;
  return canSeeRecipe(v, r) ? r : null;
}

export type AutomationInput = {
  name: string; prompt?: string; recipeId?: string | null; trigger: "schedule" | "condition"; config: unknown; oneShot?: boolean; enabled?: boolean;
};

function parsed(trigger: TriggerKind, config: unknown): ParsedTrigger {
  const t = safeParseTrigger(trigger, config);
  if (!t) throw new AutomationError(400, trigger === "schedule" ? "Pick the days and a time." : "Say what to look for and how often.");
  return t;
}

const MAX_AUTOMATIONS = 30;

export async function createAutomation(v: Viewer, input: AutomationInput, now = new Date()): Promise<AutomationDTO> {
  assertCanCreate(v);
  const t = parsed(input.trigger, input.config);
  let prompt = input.prompt?.trim() ?? "";
  if (input.recipeId) {
    const r = await visibleRecipe(v, input.recipeId);
    if (!r) throw new AutomationError(404, "That recipe doesn't exist or isn't visible to you.");
    if (!prompt) prompt = r.prompt;
  }
  if (!prompt) throw new AutomationError(400, "Say what the assistant should do, or pick a recipe.");
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(automations).where(own(v));
  if (n >= MAX_AUTOMATIONS) throw new AutomationError(409, `You already have ${MAX_AUTOMATIONS} automations here. Remove one you no longer use first.`);
  const next = nextRun(t, now);
  if (!next) throw new AutomationError(400, "That time is in the past. Pick a later date.");
  const enabled = input.enabled ?? true;
  const [row] = await db.insert(automations).values({
    graphId: v.graphId, ownerId: v.id, name: input.name.trim(), prompt, recipeId: input.recipeId ?? null, trigger: t.trigger,
    config: t.config as Record<string, unknown>, oneShot: !!input.oneShot, enabled, nextRunAt: next,
  }).returning();
  return toDTO(row, undefined);
}

export type AutomationPatch = Partial<Omit<AutomationInput, "trigger">> & { trigger?: "schedule" | "condition" };

export async function updateAutomation(v: Viewer, id: string, patch: AutomationPatch, now = new Date()): Promise<AutomationDTO> {
  const a = await ownAutomationRow(v, id);
  assertCanCreate(v);
  if (a.trigger === "heartbeat" && (patch.trigger || patch.prompt !== undefined || patch.recipeId !== undefined)) {
    throw new AutomationError(400, "Change the check-in from its own settings.");
  }
  const set: Partial<typeof automations.$inferInsert> = { updatedAt: now };
  if (patch.name !== undefined) set.name = patch.name.trim();
  if (patch.prompt !== undefined) set.prompt = patch.prompt.trim();
  if (patch.recipeId !== undefined) {
    if (patch.recipeId && !(await visibleRecipe(v, patch.recipeId))) throw new AutomationError(404, "That recipe doesn't exist or isn't visible to you.");
    set.recipeId = patch.recipeId;
  }
  if (patch.oneShot !== undefined) set.oneShot = patch.oneShot;
  const trigger = patch.trigger ?? a.trigger;
  const configChanged = patch.config !== undefined || patch.trigger !== undefined;
  const t = parsed(trigger, patch.config ?? a.config);
  if (configChanged) { set.trigger = t.trigger; set.config = t.config as Record<string, unknown>; }
  const enabled = patch.enabled ?? a.enabled;
  set.enabled = enabled;
  if (enabled && (configChanged || !a.enabled || !a.nextRunAt)) {
    const next = nextRun(t, now);
    if (!next) throw new AutomationError(400, "That time is in the past. Pick a later date.");
    set.nextRunAt = next;
  }
  if (!enabled) set.nextRunAt = null;
  if (set.prompt === "" && !(set.recipeId ?? a.recipeId)) throw new AutomationError(400, "Say what the assistant should do, or pick a recipe.");
  const [row] = await db.update(automations).set(set).where(and(own(v), eq(automations.id, id))).returning();
  return toDTO(row, (await lastRuns([row.id])).get(row.id));
}

export async function deleteAutomation(v: Viewer, id: string): Promise<void> {
  await ownAutomationRow(v, id);
  assertCanCreate(v);
  await db.delete(automations).where(and(own(v), eq(automations.id, id)));
}

/* ── Heartbeat: one per person per graph ─────────────────────────────────────────────────────────────── */

export const HEARTBEAT_PROMPT = "Check what changed and what needs me soon. Only propose; never change anything.";

export async function getHeartbeatRow(v: Viewer): Promise<AutomationRow | null> {
  const [a] = await db.select().from(automations).where(and(own(v), eq(automations.trigger, "heartbeat"))).orderBy(asc(automations.createdAt)).limit(1);
  return a ?? null;
}

export async function getHeartbeat(v: Viewer): Promise<AutomationDTO | null> {
  assertCanUse(v);
  const a = await getHeartbeatRow(v);
  return a ? toDTO(a, (await lastRuns([a.id])).get(a.id)) : null;
}

export async function setHeartbeat(v: Viewer, input: { enabled?: boolean; config?: unknown }, now = new Date()): Promise<AutomationDTO> {
  assertCanCreate(v);
  const cur = await getHeartbeatRow(v);
  const t = parsed("heartbeat", input.config ?? cur?.config ?? { tz: DEFAULT_TZ });
  const enabled = input.enabled ?? cur?.enabled ?? false;
  const next = enabled ? nextRun(t, now) : null;
  if (!cur) {
    // The advisory lock keeps two quick toggles from creating two check-ins.
    const row = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`mg:heartbeat:${v.graphId}:${v.id}`}))`);
      const [again] = await tx.select().from(automations).where(and(own(v), eq(automations.trigger, "heartbeat"))).limit(1);
      if (again) {
        const [u] = await tx.update(automations).set({ config: t.config as Record<string, unknown>, enabled, nextRunAt: next, updatedAt: now })
          .where(eq(automations.id, again.id)).returning();
        return u;
      }
      const [ins] = await tx.insert(automations).values({
        graphId: v.graphId, ownerId: v.id, name: "Check-in", prompt: HEARTBEAT_PROMPT, trigger: "heartbeat",
        config: t.config as Record<string, unknown>, enabled, nextRunAt: next,
      }).returning();
      return ins;
    });
    return toDTO(row, undefined);
  }
  const [row] = await db.update(automations).set({ config: t.config as Record<string, unknown>, enabled, nextRunAt: next, updatedAt: now })
    .where(eq(automations.id, cur.id)).returning();
  return toDTO(row, (await lastRuns([row.id])).get(row.id));
}

/* ── Runs ────────────────────────────────────────────────────────────────────────────────────────────── */

export async function listRuns(v: Viewer, automationId: string, limit = 20): Promise<RunDTO[]> {
  const a = await ownAutomationRow(v, automationId);
  const rows = await db.select().from(automationRuns).where(and(eq(automationRuns.automationId, a.id), eq(automationRuns.graphId, v.graphId)))
    .orderBy(desc(automationRuns.startedAt)).limit(Math.min(Math.max(limit, 1), 100));
  return rows.map((r) => runDTO(r, a.name));
}

/** One run (an automation's or a recipe's) with the suggestions it made, if the viewer may see it. */
export async function getRun(v: Viewer, runId: string): Promise<{ run: RunDTO; suggestions: Awaited<ReturnType<typeof selectSuggestions>> } | null> {
  assertCanUse(v);
  if (!UUID.test(runId)) return null;
  const [ar] = await db.select({ run: automationRuns, name: automations.name }).from(automationRuns)
    .innerJoin(automations, eq(automations.id, automationRuns.automationId))
    .where(and(eq(automationRuns.id, runId), eq(automationRuns.graphId, v.graphId), eq(automations.ownerId, v.id))).limit(1);
  let run: RunDTO | null = ar ? runDTO(ar.run, ar.name) : null;
  if (!run) {
    const [rr] = await db.select({ run: recipeRuns, name: recipes.name }).from(recipeRuns)
      .innerJoin(recipes, eq(recipes.id, recipeRuns.recipeId))
      .where(and(eq(recipeRuns.id, runId), eq(recipeRuns.graphId, v.graphId), eq(recipeRuns.userId, v.id))).limit(1);
    run = rr ? recipeRunDTO(rr.run, rr.name) : null;
  }
  if (!run) return null;
  return { run, suggestions: await selectSuggestions(v, { status: "all", runId, limit: 50 }) };
}

/** Runs and suggestion counts this week, for the usage line in Assistant settings. */
export async function runsSince(v: Viewer, since: Date): Promise<number> {
  const [a] = await db.select({ n: sql<number>`count(*)::int` }).from(automationRuns)
    .innerJoin(automations, eq(automations.id, automationRuns.automationId))
    .where(and(eq(automationRuns.graphId, v.graphId), eq(automations.ownerId, v.id), gte(automationRuns.startedAt, since)));
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(recipeRuns)
    .where(and(eq(recipeRuns.graphId, v.graphId), eq(recipeRuns.userId, v.id), gte(recipeRuns.startedAt, since)));
  return (a?.n ?? 0) + (r?.n ?? 0);
}
