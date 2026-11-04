/**
 * Storage for the assistant's own work: settings, the activity log and the suggestions inbox. Server-only.
 * Everything is filtered by graph AND person; nothing here reads another graph.
 */
import { and, desc, eq, gte, inArray, lt, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { assistantActivity, assistantSettings, graphMembers, suggestions } from "@/db/schema";
import type { Viewer } from "@/lib/auth";
import { scopeOf } from "@/lib/graphs/pure";
import type { Activity, ActivityInput, AssistantSettings, Suggestion, SuggestionInput } from "./index";
import { DEFAULT_SETTINGS } from "./index";
import {
  dedupeGroup, dedupeVerdict, MAX_DAILY_CAP, overDailyCap, startOfLocalDay, SUGGESTION_TTL_DAYS, validatePayload,
} from "./policy";

export class AutomationError extends Error {
  constructor(public status: 400 | 403 | 404 | 409 | 422 | 503, message: string) {
    super(message);
    this.name = "AutomationError";
  }
}

/* ── Settings ────────────────────────────────────────────────────────────────────────────────────────── */

type SettingsRow = typeof assistantSettings.$inferSelect;

export function toSettings(r: SettingsRow | undefined): AssistantSettings {
  if (!r) return { ...DEFAULT_SETTINGS, capabilities: { ...DEFAULT_SETTINGS.capabilities } };
  const tone = r.tone === "brief" || r.tone === "detailed" ? r.tone : "warm";
  return {
    autoSaveMemories: r.autoSaveMemories,
    alwaysAllow: Array.isArray(r.alwaysAllow) ? r.alwaysAllow.filter((x) => typeof x === "string") : [],
    capabilities: { ...DEFAULT_SETTINGS.capabilities, ...(r.capabilities ?? {}) },
    tone, dailySuggestionCap: Math.max(0, Math.min(r.dailySuggestionCap, MAX_DAILY_CAP)), onboardedAt: r.onboardedAt,
  };
}

export async function settingsFor(graphId: string, userId: string): Promise<AssistantSettings> {
  const [r] = await db.select().from(assistantSettings).where(and(eq(assistantSettings.graphId, graphId), eq(assistantSettings.userId, userId))).limit(1);
  return toSettings(r);
}

export type SettingsPatch = Partial<Omit<AssistantSettings, "onboardedAt">> & { onboarded?: boolean };

export async function writeSettings(graphId: string, userId: string, patch: SettingsPatch): Promise<AssistantSettings> {
  const set: Partial<typeof assistantSettings.$inferInsert> = { updatedAt: new Date() };
  if (patch.autoSaveMemories !== undefined) set.autoSaveMemories = patch.autoSaveMemories;
  if (patch.alwaysAllow !== undefined) set.alwaysAllow = [...new Set(patch.alwaysAllow)].slice(0, 50);
  if (patch.capabilities !== undefined) set.capabilities = patch.capabilities;
  if (patch.tone !== undefined) set.tone = patch.tone;
  if (patch.dailySuggestionCap !== undefined) set.dailySuggestionCap = Math.max(0, Math.min(patch.dailySuggestionCap, MAX_DAILY_CAP));
  if (patch.onboarded) set.onboardedAt = new Date();
  if (patch.capabilities !== undefined) {
    const current = await settingsFor(graphId, userId);
    set.capabilities = { ...current.capabilities, ...patch.capabilities };
  }
  const [r] = await db.insert(assistantSettings).values({ graphId, userId, ...set })
    .onConflictDoUpdate({ target: [assistantSettings.graphId, assistantSettings.userId], set })
    .returning();
  return toSettings(r);
}

/** Add one action kind to "Always allow" atomically (no lost update when two cards are approved at once). */
export async function addAlwaysAllow(graphId: string, userId: string, actionKind: string): Promise<void> {
  const kind = actionKind.trim().slice(0, 80);
  if (!kind) return;
  await db.insert(assistantSettings).values({ graphId, userId, alwaysAllow: [kind] })
    .onConflictDoUpdate({
      target: [assistantSettings.graphId, assistantSettings.userId],
      set: {
        alwaysAllow: sql`case when ${assistantSettings.alwaysAllow} ? ${kind} then ${assistantSettings.alwaysAllow} else ${assistantSettings.alwaysAllow} || ${JSON.stringify([kind])}::jsonb end`,
        updatedAt: new Date(),
      },
    });
}

/* ── Activity ────────────────────────────────────────────────────────────────────────────────────────── */

export async function insertActivity(a: ActivityInput): Promise<void> {
  await db.insert(assistantActivity).values({
    graphId: a.graphId, userId: a.userId ?? null, actor: a.actor, action: a.action.slice(0, 80), summary: a.summary.slice(0, 500),
    subjectType: a.subjectType ?? null, subjectId: a.subjectId && UUID.test(a.subjectId) ? a.subjectId : null,
    runId: a.runId ?? null, conversationId: a.conversationId ?? null, visibility: a.visibility ?? "household",
  });
}

const likeEscape = (s: string) => s.replace(/[%_\\]/g, "\\$&");
export const GROUP_SNOOZE_DAYS = 7;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Activity in the viewer's graph that they may see: their own, household-wide entries, and parents-only for parents. */
export function activityWhere(v: Viewer): SQL {
  const s = scopeOf(v);
  const parent = s.role === "owner" || s.role === "parent";
  const vis: SQL[] = [eq(assistantActivity.userId, v.id), eq(assistantActivity.visibility, "household")];
  if (parent) vis.push(eq(assistantActivity.visibility, "parents"));
  return and(eq(assistantActivity.graphId, v.graphId), or(...vis))!;
}

export async function selectActivity(v: Viewer, opts: { limit?: number; subjectId?: string; runId?: string; since?: Date }): Promise<Activity[]> {
  const conds: SQL[] = [activityWhere(v)];
  if (opts.subjectId) conds.push(eq(assistantActivity.subjectId, opts.subjectId));
  if (opts.runId) conds.push(eq(assistantActivity.runId, opts.runId));
  if (opts.since) conds.push(gte(assistantActivity.createdAt, opts.since));
  const rows = await db.select().from(assistantActivity).where(and(...conds))
    .orderBy(desc(assistantActivity.createdAt)).limit(Math.min(Math.max(opts.limit ?? 50, 1), 200));
  return rows.map((r) => ({
    id: r.id, actor: r.actor, action: r.action, summary: r.summary, subjectType: r.subjectType, subjectId: r.subjectId,
    runId: r.runId, conversationId: r.conversationId, createdAt: r.createdAt,
  }));
}

/* ── Suggestions ─────────────────────────────────────────────────────────────────────────────────────── */

type SuggestionRow = typeof suggestions.$inferSelect;

export function toSuggestion(r: SuggestionRow): Suggestion {
  return {
    id: r.id, kind: r.kind, title: r.title, body: r.body, payload: r.payload ?? {}, citations: r.citations ?? [],
    origin: (["chat", "automation", "heartbeat", "ingest"].includes(r.origin) ? r.origin : "automation") as Suggestion["origin"],
    runId: r.runId, conversationId: r.conversationId, status: r.status, createdAt: r.createdAt,
  };
}

export async function isMember(graphId: string, userId: string): Promise<boolean> {
  const [m] = await db.select({ id: graphMembers.userId }).from(graphMembers)
    .where(and(eq(graphMembers.graphId, graphId), eq(graphMembers.userId, userId))).limit(1);
  return !!m;
}

/** Pending suggestions older than the TTL quietly expire. */
export async function expireStale(graphId: string, userId: string, now = new Date()): Promise<void> {
  const cutoff = new Date(now.getTime() - SUGGESTION_TTL_DAYS * 24 * 3600_000);
  await db.update(suggestions).set({ status: "expired", decidedAt: now })
    .where(and(eq(suggestions.graphId, graphId), eq(suggestions.userId, userId), eq(suggestions.status, "pending"), lt(suggestions.createdAt, cutoff)));
}

export type InsertOutcome = { id: string; created: boolean } | { refused: "denied" | "capped" | "invalid" };

/**
 * Insert a suggestion under the cap and dedupe rules. Returns the id (new or the existing pending one), or null when
 * it was refused (denied before, over today's cap, not a member, invalid payload). A transaction-scoped advisory lock
 * per person and graph keeps two concurrent runs from both slipping under the cap.
 */
export async function insertSuggestion(input: SuggestionInput, cap: number, now = new Date()): Promise<InsertOutcome> {
  if (!(await isMember(input.graphId, input.userId))) return { refused: "invalid" };
  if (!validatePayload(input.kind, input.payload).ok) return { refused: "invalid" };
  await expireStale(input.graphId, input.userId, now);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`mg:suggest:${input.graphId}:${input.userId}`}))`);
    const key = input.dedupeKey?.slice(0, 300) ?? null;
    if (key) {
      const prev = await tx.select({ id: suggestions.id, status: suggestions.status }).from(suggestions)
        .where(and(eq(suggestions.graphId, input.graphId), eq(suggestions.userId, input.userId), eq(suggestions.dedupeKey, key)));
      const verdict = dedupeVerdict(prev);
      if (verdict === "never") return { refused: "denied" };
      if (verdict === "existing") {
        const pending = prev.find((p) => p.status === "pending");
        return pending ? { id: pending.id, created: false } : { refused: "denied" };
      }
    }
    const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(suggestions)
      .where(and(eq(suggestions.graphId, input.graphId), eq(suggestions.userId, input.userId),
        gte(suggestions.createdAt, startOfLocalDay(now)), inArray(suggestions.origin, ["automation", "heartbeat", "ingest"])));
    if (overDailyCap(input.origin, n, cap)) return { refused: "capped" };
    const group = dedupeGroup(key);
    if (group) {
      // A dismissed group ("due soon", "facts waiting") stays quiet for a week, even when its details change.
      const [snoozed] = await tx.select({ id: suggestions.id }).from(suggestions)
        .where(and(eq(suggestions.graphId, input.graphId), eq(suggestions.userId, input.userId), eq(suggestions.status, "denied"),
          gte(suggestions.decidedAt, new Date(now.getTime() - GROUP_SNOOZE_DAYS * 24 * 3600_000)),
          sql`${suggestions.dedupeKey} like ${`${likeEscape(group)}#%`}`)).limit(1);
      if (snoozed) return { refused: "denied" };
      await tx.update(suggestions).set({ status: "expired", decidedAt: now })
        .where(and(eq(suggestions.graphId, input.graphId), eq(suggestions.userId, input.userId), eq(suggestions.status, "pending"),
          sql`${suggestions.dedupeKey} like ${`${likeEscape(group)}#%`}`));
    }
    const [row] = await tx.insert(suggestions).values({
      graphId: input.graphId, userId: input.userId, kind: input.kind, title: input.title.slice(0, 300), body: input.body?.slice(0, 4000) ?? null,
      payload: input.payload, citations: (input.citations ?? []).slice(0, 12), origin: input.origin, runId: input.runId ?? null,
      conversationId: input.conversationId ?? null, dedupeKey: key,
    }).returning({ id: suggestions.id });
    return { id: row.id, created: true };
  });
}

export async function selectSuggestions(v: Viewer, opts: { status?: "pending" | "all"; limit?: number; runId?: string }): Promise<Suggestion[]> {
  await expireStale(v.graphId, v.id);
  const conds: SQL[] = [eq(suggestions.graphId, v.graphId), eq(suggestions.userId, v.id)];
  if ((opts.status ?? "pending") === "pending") conds.push(eq(suggestions.status, "pending"));
  if (opts.runId) conds.push(eq(suggestions.runId, opts.runId));
  const rows = await db.select().from(suggestions).where(and(...conds))
    .orderBy(desc(suggestions.createdAt)).limit(Math.min(Math.max(opts.limit ?? 50, 1), 200));
  return rows.map(toSuggestion);
}

export async function ownSuggestion(v: Viewer, id: string): Promise<SuggestionRow | null> {
  if (!UUID.test(id)) return null;
  const [r] = await db.select().from(suggestions)
    .where(and(eq(suggestions.id, id), eq(suggestions.graphId, v.graphId), eq(suggestions.userId, v.id))).limit(1);
  return r ?? null;
}

/** Atomically move a pending suggestion to its decision; false when someone (another tab) already decided it. */
export async function markDecided(v: Viewer, id: string, status: "approved" | "denied"): Promise<boolean> {
  const r = await db.update(suggestions).set({ status, decidedAt: new Date(), decidedBy: v.id })
    .where(and(eq(suggestions.id, id), eq(suggestions.graphId, v.graphId), eq(suggestions.userId, v.id), eq(suggestions.status, "pending")))
    .returning({ id: suggestions.id });
  return r.length > 0;
}

export async function revertToPending(id: string): Promise<void> {
  await db.update(suggestions).set({ status: "pending", decidedAt: null, decidedBy: null }).where(eq(suggestions.id, id));
}

/** How many suggestions this person got in a window, and how many they accepted (shown so nudging stays honest). */
export async function suggestionStats(v: Viewer, since: Date): Promise<{ total: number; approved: number; denied: number }> {
  const [r] = await db.select({
    total: sql<number>`count(*)::int`,
    approved: sql<number>`count(*) filter (where ${suggestions.status} = 'approved')::int`,
    denied: sql<number>`count(*) filter (where ${suggestions.status} = 'denied')::int`,
  }).from(suggestions).where(and(eq(suggestions.graphId, v.graphId), eq(suggestions.userId, v.id), gte(suggestions.createdAt, since)));
  return r ?? { total: 0, approved: 0, denied: 0 };
}

export async function toSuggestionById(id: string): Promise<Suggestion | null> {
  const [r] = await db.select().from(suggestions).where(eq(suggestions.id, id)).limit(1);
  return r ? toSuggestion(r) : null;
}

/** markDecided for a suggestion addressed to this viewer (auto-apply path). */
export async function markDecidedById(v: Viewer, id: string, status: "approved" | "denied"): Promise<boolean> {
  return markDecided(v, id, status);
}
