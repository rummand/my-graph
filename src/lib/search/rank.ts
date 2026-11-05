/**
 * Ranking. One 0..100 scale across sections so the top hit can be chosen fairly:
 *
 *   100 exact name · 92 name starts with the query · 84 every word starts a word of the name · 76 alias exact
 *   70 alias starts with it · 62 name contains it · 56 every word somewhere in the name · 50 alias contains it
 *   30–45 the words are in the text (full-text rank added) · 15–29 close in meaning only (embeddings)
 *
 * Pure: shared by the server (scores) and the palette (commands and recent items use the same scale).
 */
import { foldCase } from "./highlight";
import type { Hit, Section } from "./types";
import { SECTIONS } from "./types";

export const TIER = {
  exact: 100, prefix: 92, wordPrefix: 84, aliasExact: 76, aliasPrefix: 70, contains: 62, allWords: 56, aliasContains: 50,
  text: 30, meaning: 15,
} as const;

/** A top hit must at least match by name words; text-only matches never become the top hit. */
export const TOP_HIT_MIN = TIER.allWords;

const norm = (s: string) => foldCase(s).replace(/\s+/g, " ").trim();
const wordsOf = (s: string) => norm(s).split(/[^\p{L}\p{N}§]+/u).filter(Boolean);

/** How well a name matches the query (0 = not by name). */
export function nameScore(name: string, query: string, terms: string[]): number {
  const n = norm(name);
  const q = norm(query);
  if (!n || !q) return 0;
  if (n === q) return TIER.exact;
  if (n.startsWith(q)) return TIER.prefix - Math.min(6, (n.length - q.length) / 8);
  const ws = wordsOf(n);
  if (terms.length && terms.every((t) => ws.some((w) => w.startsWith(t)))) return TIER.wordPrefix;
  if (n.includes(q)) return TIER.contains;
  if (terms.length && terms.every((t) => n.includes(t))) return TIER.allWords;
  return 0;
}

/** Best of a name and its aliases (aliases rank a step below the name). */
export function labelScore(label: string, aliases: readonly string[] | null | undefined, query: string, terms: string[]): { score: number; via: "title" | "alias" } | null {
  const own = nameScore(label, query, terms);
  let alias = 0;
  for (const a of aliases ?? []) {
    const s = nameScore(a, query, terms);
    const mapped = s >= TIER.exact ? TIER.aliasExact : s >= TIER.wordPrefix ? TIER.aliasPrefix : s > 0 ? TIER.aliasContains : 0;
    alias = Math.max(alias, mapped);
  }
  if (own >= alias && own > 0) return { score: own, via: "title" };
  if (alias > 0) return { score: alias, via: "alias" };
  return null;
}

/** A text-only match: 30..45 by Postgres ts_rank (0..1, usually small). */
export function textScore(tsRank: number | null | undefined): number {
  const r = Math.max(0, Math.min(1, Number(tsRank) || 0));
  return TIER.text + Math.round(Math.sqrt(r) * 15 * 10) / 10;
}

/** A meaning-only match: 15..29 by cosine similarity (0..1). */
export function meaningScore(similarity: number): number {
  const s = Math.max(0, Math.min(1, similarity));
  return TIER.meaning + Math.round(s * 14 * 10) / 10;
}

/** Small nudges that break ties: people first among nodes, recent things before old ones. */
export function nudge(h: Pick<Hit, "kind" | "date">, now = Date.now()): number {
  let n = 0;
  if (h.kind === "person") n += 1.5;
  if (h.date) {
    const days = (now - Date.parse(h.date)) / 86_400_000;
    if (Number.isFinite(days)) n += days < 30 ? 1 : days < 365 ? 0.5 : 0;
  }
  return n;
}

/** Combine hit lists (keyword, alias, meaning …): one per key, the best score and its way of matching kept. */
export function mergeHits(lists: Hit[][]): Hit[] {
  const by = new Map<string, Hit>();
  for (const list of lists) {
    for (const h of list) {
      const prev = by.get(h.key);
      if (!prev) { by.set(h.key, h); continue; }
      const best = h.score > prev.score ? h : prev;
      by.set(h.key, { ...best, snippet: best.snippet ?? prev.snippet ?? h.snippet, locator: best.locator ?? prev.locator ?? h.locator });
    }
  }
  return [...by.values()];
}

export type SortOrder = "relevance" | "newest";

export function sortHits(hits: Hit[], order: SortOrder = "relevance"): Hit[] {
  const byDate = (a: Hit, b: Hit) => (Date.parse(b.date ?? "") || 0) - (Date.parse(a.date ?? "") || 0);
  return [...hits].sort(order === "newest"
    ? (a, b) => byDate(a, b) || b.score - a.score
    : (a, b) => b.score - a.score || byDate(a, b) || a.title.localeCompare(b.title));
}

/** The single best hit across sections, when it matched by name; ties go to the section shown first. */
export function pickTop(sections: { id: Section; items: Hit[] }[]): Hit | null {
  let best: Hit | null = null;
  for (const id of SECTIONS) {
    const s = sections.find((x) => x.id === id);
    for (const h of s?.items ?? []) if (h.score >= TOP_HIT_MIN && (!best || h.score > best.score)) best = h;
  }
  return best;
}
