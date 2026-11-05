/**
 * Search's own access helpers (pure). The row-level rules are the owning libraries' (GBrain's nodeReadSql,
 * sourceVisibleTo, pageReadSql, canSeeArtifact, the change sets' visibleSql); these decide what search adds on top:
 * which sections a role gets, and when a passage may be shown.
 */
import type { Section } from "./types";
import { SECTIONS } from "./types";

type Who = { id: string; role: string };

/** Sections a role may search. Guests: only what was shared with them (graph items); children: no rule sets. */
export function sectionsFor(v: Who): Section[] {
  if (v.role === "guest") return ["nodes", "events"];
  if (v.role === "child") return SECTIONS.filter((s) => s !== "rules");
  return [...SECTIONS];
}

/**
 * A passage (snippet) of an item may be shown when it isn't sensitive, or the viewer owns it. Someone else's
 * sensitive item can still be found by its name if the viewer may read it, but its words never show in results.
 */
export function snippetAllowed(v: Who, item: { ownerId: string; sensitive?: boolean | null }): boolean {
  return !item.sensitive || item.ownerId === v.id;
}

/** localStorage keys: per graph, so nothing typed or opened in one graph shows in another. */
export function recentKey(graphId: string, what: "items" | "queries"): string {
  return `mg:search:${what}:${graphId}`;
}

export type RecentItem = { key: string; kind: string; title: string; href: string; context?: string; colorId?: string | null; sub?: string | null; at: number };

/** Add to the front of a recent list, without duplicates, capped. */
export function pushRecent<T extends { key: string }>(list: T[], item: T, cap = 8): T[] {
  return [item, ...list.filter((x) => x.key !== item.key)].slice(0, cap);
}

/** Recent queries: trimmed, case-insensitively unique, capped. */
export function pushQuery(list: string[], q: string, cap = 6): string[] {
  const t = q.trim();
  if (t.length < 2) return list;
  return [t, ...list.filter((x) => x.toLowerCase() !== t.toLowerCase())].slice(0, cap);
}

/** Read a stored list defensively (old shapes, other tabs, hand-edited storage). */
export function readList<T>(raw: string | null, valid: (x: unknown) => x is T): T[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter(valid) : [];
  } catch {
    return [];
  }
}
