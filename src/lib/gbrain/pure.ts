/**
 * GBrain pure helpers: name normalisation, similarity, rank fusion, small value rules.
 * No database or network access here — everything is unit-tested in pure.test.ts.
 */

export type Vis = "private" | "parents" | "household";

/* ── Names ───────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * Case-, accent- and punctuation-insensitive form of a label, used for entity resolution.
 * Danish letters follow the usual transliteration (å → aa, æ → ae, ø → oe) so "Århus" equals "Aarhus".
 */
export function normalizeLabel(s: string): string {
  return s
    .toLowerCase()
    .replace(/å/g, "aa").replace(/æ/g, "ae").replace(/ø/g, "oe").replace(/ß/g, "ss")
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Every normalised name a node is known by (label + aliases), empty forms dropped. */
export function nameKeys(label: string, aliases: readonly string[] = []): string[] {
  const out = new Set<string>();
  for (const s of [label, ...aliases]) {
    const k = normalizeLabel(s);
    if (k) out.add(k);
  }
  return [...out];
}

/** True when the two sets of names share at least one normalised form. */
export function namesMatch(a: { label: string; aliases?: readonly string[] }, b: { label: string; aliases?: readonly string[] }): boolean {
  const ka = new Set(nameKeys(a.label, a.aliases));
  return nameKeys(b.label, b.aliases).some((k) => ka.has(k));
}

/** Merge alias lists: keeps the first spelling of each normalised name and never repeats the label itself. */
export function mergeAliases(label: string, ...lists: (readonly string[] | undefined)[]): string[] {
  const seen = new Set([normalizeLabel(label)]);
  const out: string[] = [];
  for (const list of lists) {
    for (const raw of list ?? []) {
      const s = raw.trim();
      const k = normalizeLabel(s);
      if (!s || !k || seen.has(k)) continue;
      seen.add(k);
      out.push(s);
    }
  }
  return out;
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let cur = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

/** 1 − normalised edit distance on normalised labels (0..1). */
export function editSimilarity(a: string, b: string): number {
  const x = normalizeLabel(a), y = normalizeLabel(b);
  if (!x || !y) return 0;
  return 1 - levenshtein(x, y) / Math.max(x.length, y.length);
}

function tokens(s: string): string[] {
  return normalizeLabel(s).split(" ").filter(Boolean);
}

/** Jaccard overlap of the words in two labels (0..1). */
export function tokenJaccard(a: string, b: string): number {
  const x = new Set(tokens(a)), y = new Set(tokens(b));
  if (!x.size || !y.size) return 0;
  let inter = 0;
  for (const t of x) if (y.has(t)) inter++;
  return inter / (x.size + y.size - inter);
}

export type Similarity = { score: number; reason: string };

/** How likely two names refer to the same thing, with a plain-English reason. */
export function nameSimilarity(a: { label: string; aliases?: readonly string[] }, b: { label: string; aliases?: readonly string[] }): Similarity {
  const la = normalizeLabel(a.label), lb = normalizeLabel(b.label);
  if (la && la === lb) {
    return { score: 1, reason: a.label === b.label ? "Same name" : "Same name apart from capitals, accents or punctuation" };
  }
  if (namesMatch(a, b)) return { score: 0.95, reason: "One is listed as another name for the other" };

  let best: Similarity = { score: 0, reason: "" };
  const consider = (score: number, reason: string) => { if (score > best.score) best = { score, reason }; };

  const ed = editSimilarity(a.label, b.label);
  if (Math.min(la.length, lb.length) >= 4) consider(ed, `Spelled almost the same ("${a.label}" and "${b.label}")`);

  const ta = tokens(a.label), tb = tokens(b.label);
  const jac = tokenJaccard(a.label, b.label);
  if (jac > 0) consider(jac, `Share the words "${ta.filter((t) => tb.includes(t)).join(" ")}"`);

  // One name is fully contained in the other ("Hansen" / "Dr. Hansen"), as long as it is a real word.
  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  if (short.length && short.length < long.length && short.every((t) => long.includes(t)) && short.join("").length >= 3) {
    consider(0.8, `"${(ta.length <= tb.length ? a : b).label}" is part of "${(ta.length <= tb.length ? b : a).label}"`);
  }
  return { score: Math.round(best.score * 1000) / 1000, reason: best.reason };
}

export type SuggestionCandidate = { id: string; type: string; label: string; aliases: string[]; notSame?: string[] };

/**
 * Pairs of same-type candidates that look like the same entity, best first.
 * Blocks on words and 3-letter prefixes so it stays fast for a few thousand nodes.
 */
export function findMergePairs(items: SuggestionCandidate[], opts: { threshold?: number; limit?: number; focusId?: string } = {}): { aId: string; bId: string; score: number; reason: string }[] {
  const threshold = opts.threshold ?? 0.75;
  const blocks = new Map<string, number[]>();
  items.forEach((it, i) => {
    const keys = new Set<string>();
    for (const name of nameKeys(it.label, it.aliases)) {
      keys.add(`p:${name.replace(/ /g, "").slice(0, 3)}`);
      for (const t of name.split(" ")) if (t.length >= 3) keys.add(`w:${t}`);
    }
    for (const k of keys) {
      const key = `${it.type}|${k}`;
      const list = blocks.get(key);
      if (list) list.push(i); else blocks.set(key, [i]);
    }
  });
  const seen = new Set<string>();
  const out: { aId: string; bId: string; score: number; reason: string }[] = [];
  for (const list of blocks.values()) {
    if (list.length > 200) continue; // a very common word ("school") says nothing on its own
    for (let x = 0; x < list.length; x++) {
      for (let y = x + 1; y < list.length; y++) {
        const a = items[list[x]], b = items[list[y]];
        if (a.id === b.id || a.type !== b.type) continue;
        if (opts.focusId && a.id !== opts.focusId && b.id !== opts.focusId) continue;
        const pair = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
        if (seen.has(pair)) continue;
        seen.add(pair);
        if (a.notSame?.includes(b.id) || b.notSame?.includes(a.id)) continue;
        const sim = nameSimilarity(a, b);
        if (sim.score >= threshold) out.push({ aId: a.id, bId: b.id, ...sim });
      }
    }
  }
  out.sort((p, q) => q.score - p.score || p.aId.localeCompare(q.aId));
  return opts.limit ? out.slice(0, opts.limit) : out;
}

/* ── Search ──────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * Reciprocal rank fusion: each list is best-first; an item's score is Σ 1/(k + rank).
 * Items are identified by `key`; the first-seen `item` is kept.
 */
export function rrfFuse<T>(lists: { key: string; item: T }[][], k = 60): { key: string; item: T; score: number }[] {
  const acc = new Map<string, { key: string; item: T; score: number }>();
  for (const list of lists) {
    list.forEach((entry, rank) => {
      const cur = acc.get(entry.key);
      const add = 1 / (k + rank + 1);
      if (cur) cur.score += add;
      else acc.set(entry.key, { key: entry.key, item: entry.item, score: add });
    });
  }
  return [...acc.values()].sort((a, b) => b.score - a.score);
}

/**
 * A safe prefix tsquery for Postgres `to_tsquery('simple', …)`: every word must appear, as a prefix.
 * Returns null when the query has no searchable words.
 */
export function toPrefixTsQuery(q: string): string | null {
  const words = q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const uniq = [...new Set(words)].slice(0, 12);
  return uniq.length ? uniq.map((w) => `${w}:*`).join(" & ") : null;
}

/** Same as toPrefixTsQuery but any word may match (used as a fallback when the AND query finds nothing). */
export function toAnyPrefixTsQuery(q: string): string | null {
  const words = q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const uniq = [...new Set(words)].slice(0, 12);
  return uniq.length ? uniq.map((w) => `${w}:*`).join(" | ") : null;
}

export function vectorLiteral(v: readonly number[]): string {
  return `[${v.map((x) => (Number.isFinite(x) ? x : 0)).join(",")}]`;
}

/* ── Facts ───────────────────────────────────────────────────────────────────────────────────────────── */

export function clamp01(x: number | undefined | null, fallback = 1): number {
  if (x === undefined || x === null || Number.isNaN(x)) return fallback;
  return Math.min(1, Math.max(0, x));
}

/** Independent evidence: 1 − (1−a)(1−b). */
export function noisyOr(a: number, b: number): number {
  return 1 - (1 - clamp01(a)) * (1 - clamp01(b));
}

/** "Parent Of" / "parent-of" / "parentOf" → "parent_of". Returns "" if nothing usable is left. */
export function normalizeRelation(r: string): string {
  return r
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^[0-9_]+/, "");
}

/** "parent_of" → "parent of". */
export function humanizeRelation(r: string): string {
  return r.replace(/_/g, " ");
}

const VIS_RANK: Record<Vis, number> = { private: 0, parents: 1, household: 2 };

/** The narrower of two visibilities (a fact between a private and a household node is private). */
export function narrowerVisibility(a: Vis, b: Vis): Vis {
  return VIS_RANK[a] <= VIS_RANK[b] ? a : b;
}

/** Default status for a new fact, unless the caller sets one. Inferred facts are never promoted here. */
export function defaultEdgeStatus(prov: { activity: string; agentType: string }): "confirmed" | "unconfirmed" | "inferred" {
  if (prov.activity === "inference") return "inferred";
  if (prov.agentType === "user") return "confirmed";
  return "unconfirmed";
}

/** Status after the same fact is asserted again. Only an explicit user confirmation changes it. */
export function statusAfterReassert(
  current: "confirmed" | "unconfirmed" | "inferred",
  incoming: { status?: string; agentType: string },
): "confirmed" | "unconfirmed" | "inferred" {
  if (incoming.agentType === "user" && incoming.status === "confirmed") return "confirmed";
  return current;
}
