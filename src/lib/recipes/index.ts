/**
 * Recipes: saved prompts the family writes ("Weekly family summary"), usable from chat, Today or as an automation.
 * Server-only. Scoped to the viewer's graph and the recipe's visibility; only the person who wrote one may change it.
 */
import { and, asc, desc, eq, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { assistantActivity, recipeRuns, recipes } from "@/db/schema";
import type { Citation } from "@/db/schema";
import type { Viewer } from "@/lib/auth";
import { scopeOf } from "@/lib/graphs/pure";
import { runTask } from "@/lib/assistant/run";
import { logActivity } from "@/lib/automations";
import { canCreateAssistantWork, canUseAssistantTools } from "@/lib/automations/policy";
import { AutomationError } from "@/lib/automations/store";
import { canEditRecipe, fillRecipe, recipePlaceholders, STARTER_RECIPES, type RecipeVisibility } from "./pure";

export { recipePlaceholders, fillRecipe, STARTER_RECIPES } from "./pure";

export type RecipeDTO = {
  id: string; name: string; description: string; prompt: string; ownerId: string; visibility: RecipeVisibility;
  placeholders: string[]; mine: boolean; canEdit: boolean; updatedAt: string;
  lastRun: { id: string; status: string; startedAt: string; summary: string | null } | null;
};

type Row = typeof recipes.$inferSelect;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function visible(v: Viewer): SQL {
  const s = scopeOf(v);
  const vis: SQL[] = [eq(recipes.ownerId, v.id)];
  if (s.role !== "guest") vis.push(eq(recipes.visibility, "household"));
  if (s.role === "owner" || s.role === "parent") vis.push(eq(recipes.visibility, "parents"));
  return and(eq(recipes.graphId, v.graphId), or(...vis))!;
}

function assertUse(v: Viewer) {
  if (!canUseAssistantTools(v)) throw new AutomationError(403, "Recipes are for parents.");
}
function assertCreate(v: Viewer) {
  assertUse(v);
  if (!canCreateAssistantWork(v)) throw new AutomationError(403, "You can look at this graph but not add recipes to it.");
}

function toDTO(v: Viewer, r: Row, last?: typeof recipeRuns.$inferSelect): RecipeDTO {
  return {
    id: r.id, name: r.name, description: r.description, prompt: r.prompt, ownerId: r.ownerId, visibility: r.visibility,
    placeholders: recipePlaceholders(r.prompt), mine: r.ownerId === v.id, canEdit: canEditRecipe(v, r), updatedAt: r.updatedAt.toISOString(),
    lastRun: last ? { id: last.id, status: last.status, startedAt: last.startedAt.toISOString(), summary: last.summary } : null,
  };
}

/** The four starter recipes, once per graph (the first time someone who may add recipes opens the list). */
async function seedStarters(v: Viewer): Promise<void> {
  if (!canCreateAssistantWork(v)) return;
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`mg:recipes-seed:${v.graphId}`}))`);
    const [done] = await tx.select({ id: assistantActivity.id }).from(assistantActivity)
      .where(and(eq(assistantActivity.graphId, v.graphId), eq(assistantActivity.action, "seeded_recipes"))).limit(1);
    if (done) return;
    await tx.insert(recipes).values(STARTER_RECIPES.map((r) => ({ graphId: v.graphId, ownerId: v.id, name: r.name, description: r.description, prompt: r.prompt, visibility: "household" as const })));
    await tx.insert(assistantActivity).values({ graphId: v.graphId, userId: v.id, actor: "automation", action: "seeded_recipes", summary: "Added the starter recipes", visibility: "household" });
  });
}

export async function listRecipesFor(v: Viewer, opts: { seed?: boolean } = {}): Promise<RecipeDTO[]> {
  if (!canUseAssistantTools(v)) return [];
  if (opts.seed) await seedStarters(v).catch((e) => console.error("[recipes] seeding failed:", e instanceof Error ? e.message : e));
  const rows = await db.select().from(recipes).where(visible(v)).orderBy(asc(recipes.createdAt)).limit(200);
  if (!rows.length) return [];
  const last = await db.selectDistinctOn([recipeRuns.recipeId]).from(recipeRuns)
    .where(and(eq(recipeRuns.graphId, v.graphId), eq(recipeRuns.userId, v.id)))
    .orderBy(recipeRuns.recipeId, desc(recipeRuns.startedAt));
  const lastOf = new Map(last.map((r) => [r.recipeId, r]));
  return rows.map((r) => toDTO(v, r, lastOf.get(r.id)));
}

async function visibleRow(v: Viewer, id: string): Promise<Row> {
  assertUse(v);
  if (!UUID.test(id)) throw new AutomationError(404, "That recipe doesn't exist.");
  const [r] = await db.select().from(recipes).where(and(visible(v), eq(recipes.id, id))).limit(1);
  if (!r) throw new AutomationError(404, "That recipe doesn't exist.");
  return r;
}

export type RecipeInput = { name: string; description?: string; prompt: string; visibility?: RecipeVisibility };

export async function createRecipe(v: Viewer, input: RecipeInput): Promise<RecipeDTO> {
  assertCreate(v);
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(recipes).where(and(eq(recipes.graphId, v.graphId), eq(recipes.ownerId, v.id)));
  if (n >= 100) throw new AutomationError(409, "You already have 100 recipes here. Remove one you no longer use first.");
  const [r] = await db.insert(recipes).values({
    graphId: v.graphId, ownerId: v.id, name: input.name.trim(), description: input.description?.trim() ?? "", prompt: input.prompt.trim(),
    visibility: input.visibility ?? "household",
  }).returning();
  return toDTO(v, r);
}

export async function updateRecipe(v: Viewer, id: string, patch: Partial<RecipeInput>): Promise<RecipeDTO> {
  const r = await visibleRow(v, id);
  if (!canEditRecipe(v, r)) throw new AutomationError(403, "Only the person who wrote this recipe can change it.");
  const set: Partial<typeof recipes.$inferInsert> = { updatedAt: new Date() };
  if (patch.name !== undefined) set.name = patch.name.trim();
  if (patch.description !== undefined) set.description = patch.description.trim();
  if (patch.prompt !== undefined) set.prompt = patch.prompt.trim();
  if (patch.visibility !== undefined) set.visibility = patch.visibility;
  const [u] = await db.update(recipes).set(set).where(and(eq(recipes.id, r.id), eq(recipes.graphId, v.graphId))).returning();
  return toDTO(v, u);
}

export async function deleteRecipe(v: Viewer, id: string): Promise<void> {
  const r = await visibleRow(v, id);
  if (!canEditRecipe(v, r)) throw new AutomationError(403, "Only the person who wrote this recipe can remove it.");
  await db.delete(recipes).where(and(eq(recipes.id, r.id), eq(recipes.graphId, v.graphId)));
}

export type RecipeRunResult = {
  runId: string; status: "done" | "failed"; text: string; summary: string; citations: Citation[];
  steps: { kind: string; label: string; count?: number }[]; skipped: string[]; suggestionIds: string[]; degraded: boolean;
};

/** Run a recipe now, as the viewer, with the stricter unattended policy (it proposes; it doesn't write). */
export async function runRecipe(v: Viewer, id: string, values: Record<string, string> = {}): Promise<RecipeRunResult> {
  const r = await visibleRow(v, id);
  assertCreate(v);
  const prompt = fillRecipe(r.prompt, values);
  const [run] = await db.insert(recipeRuns).values({ recipeId: r.id, graphId: v.graphId, userId: v.id, prompt, status: "running" }).returning({ id: recipeRuns.id });
  try {
    const res = await runTask(v, { prompt, mode: "unattended", runId: run.id, origin: "recipe" });
    const failed = res.degraded && !res.text.trim();
    const summary = (res.summary || (failed ? "The assistant couldn't run this recipe." : res.text.slice(0, 200))).slice(0, 1000);
    await db.update(recipeRuns).set({
      status: failed ? "failed" : "done", finishedAt: new Date(), summary, output: res.text || null, citations: res.citations.slice(0, 20),
      steps: res.steps.slice(0, 30), skipped: res.skipped.slice(0, 30), suggestionCount: res.suggestionIds.length, error: failed ? summary : null,
    }).where(eq(recipeRuns.id, run.id));
    await logActivity({ graphId: v.graphId, userId: v.id, actor: "automation", action: failed ? "recipe_failed" : "ran_recipe",
      summary: `${fillRecipe(r.name, values).replace("(not given)", "…")}: ${summary}`.slice(0, 500), subjectType: "recipe", subjectId: r.id, runId: run.id, visibility: "private" });
    return { runId: run.id, status: failed ? "failed" : "done", text: res.text, summary, citations: res.citations, steps: res.steps, skipped: res.skipped, suggestionIds: res.suggestionIds, degraded: res.degraded };
  } catch (e) {
    const msg = e instanceof Error ? e.message.slice(0, 300) : "Unknown error";
    await db.update(recipeRuns).set({ status: "failed", finishedAt: new Date(), summary: "The recipe stopped with an error.", error: msg }).where(eq(recipeRuns.id, run.id)).catch(() => {});
    return { runId: run.id, status: "failed", text: "", summary: "The recipe stopped with an error. Try again in a moment.", citations: [], steps: [], skipped: [], suggestionIds: [], degraded: true };
  }
}
