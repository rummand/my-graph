/**
 * The web budget of one unattended run (automation, recipe, check-in): at most 3 searches and 5 page reads, however
 * many times the run asks. Budgets are kept in memory by run id for an hour, so the steps of one run share theirs.
 * Pure apart from that small map; no database.
 */
export const RUN_WEB_LIMITS = { searches: 3, reads: 5 } as const;

export type WebBudget = { searches: number; reads: number; usedSearches: number; usedReads: number };

export function newWebBudget(limits: { searches: number; reads: number } = RUN_WEB_LIMITS): WebBudget {
  return { searches: limits.searches, reads: limits.reads, usedSearches: 0, usedReads: 0 };
}

export const searchesLeft = (b: WebBudget) => Math.max(0, b.searches - b.usedSearches);
export const readsLeft = (b: WebBudget) => Math.max(0, b.reads - b.usedReads);

/** What one research call may do now: search only if a search is left; read at most `max` pages and what is left. */
export function webAllowance(b: WebBudget, need: { search: boolean; max: number }): { search: boolean; reads: number } | null {
  const reads = Math.min(need.max, readsLeft(b));
  if (reads <= 0) return null;
  if (need.search && searchesLeft(b) <= 0) return null;
  return { search: need.search, reads };
}

export function spendWeb(b: WebBudget, used: { searches: number; reads: number }): WebBudget {
  b.usedSearches += used.searches;
  b.usedReads += used.reads;
  return b;
}

const TTL = 3600_000;
const runs = new Map<string, { b: WebBudget; at: number }>();

/** The budget of a run (a fresh one for a run without an id). */
export function budgetForRun(runId: string | null | undefined, now = Date.now()): WebBudget {
  if (!runId) return newWebBudget();
  for (const [k, x] of runs) if (now - x.at > TTL) runs.delete(k);
  const hit = runs.get(runId);
  if (hit) return hit.b;
  const b = newWebBudget();
  runs.set(runId, { b, at: now });
  if (runs.size > 500) runs.delete(runs.keys().next().value!);
  return b;
}
