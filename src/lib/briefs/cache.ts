/**
 * The latest daily brief per user per day, kept in process memory (no schema change). Lost on restart — the page
 * then just offers to write it again. Kept on globalThis so dev reloads don't drop it.
 */
import type { Citation } from "@/db/schema";

export type CachedBrief = {
  text: string;
  citations: Citation[];
  /** ISO time it was written. */
  generatedAt: string;
  /** "YYYY-MM-DD" in the household time zone. */
  day: string;
  model: string | null;
  /** True when it was produced without calling a model (nothing to brief on). */
  local: boolean;
};

const g = globalThis as unknown as { __briefCache?: Map<string, CachedBrief> };
const cache: Map<string, CachedBrief> = g.__briefCache ?? new Map();
g.__briefCache = cache;

const MAX_ENTRIES = 500;

const key = (userId: string, day: string) => `${userId}|${day}`;

export function getCachedBrief(userId: string, day: string): CachedBrief | null {
  return cache.get(key(userId, day)) ?? null;
}

export function setCachedBrief(userId: string, brief: CachedBrief): void {
  // Drop this user's briefs from earlier days, and the oldest entries if the map grows large.
  for (const k of cache.keys()) if (k.startsWith(`${userId}|`) && !k.endsWith(`|${brief.day}`)) cache.delete(k);
  cache.set(key(userId, brief.day), brief);
  while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value!);
}

export function clearBriefCache(): void {
  cache.clear();
}
