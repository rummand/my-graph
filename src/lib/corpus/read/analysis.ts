/**
 * Reading passes 1–4, the parts that need no model (pure, unit-tested):
 *
 *   accountFor(unit)        units that hold no rule by their nature: headings, recitals, commencement, repeal, amendments
 *   definitionsIn(units)    terms the text defines ("1) Personoplysninger: …", "‘personal data’ means …", "ved X forstås Y")
 *   passagesFor(units)      what one model call reads: whole top units (a § with its stykker), up to ~5000 characters
 *   coverageOf(units,rules) every unit's state and the completeness report ("312 units, 298 with rules …")
 *   rereadList(…)           pass 3: the top units to read again (open units, flagged deadlines/penalties without a
 *                           rule, definitions not found, low confidence)
 *   pageOf(pages, text)     the page of the official PDF a passage is on
 *   diffUnits(old, new)     "Check for changes": units added, changed (their words moved), removed, unchanged
 *   interpretationLinks     guidance passages that talk about a § / an article, for that unit's rules
 */
import { hashText, locate } from "@/lib/compliance/text";
import { PROVISION_KINDS, TOP_KINDS, type Flag, type Unit, type UnitKind } from "./units";

export type UnitState = "ruled" | "definition" | "no_rule" | "heading" | "context" | "open";

/* ── Units that hold no rule ─────────────────────────────────────────────────────────────────────────────── */

const MODAL = /\b(skal|må|kan|bør|har pligt|har ret|er forpligtet|shall|must|may|should|is required|are required|is entitled|has the right|is prohibited|forbudt)\b/i;

/** Why a unit holds no rule, when its words alone say so; null when it may hold one. */
export function accountFor(u: { kind: UnitKind; flags: Flag[]; own: string }): string | null {
  if (u.kind === "chapter" || u.kind === "section" || u.kind === "heading" || u.kind === "preamble") return "heading";
  if (u.kind === "recital") return "context";
  // An annex line with its title only ("Bilag 1" / "Vedtægt om …"): its paragraphs are units of their own.
  if (u.kind === "annex" && u.own.length < 300) return "heading";
  const words = u.own.replace(/^(§\s*\d+\s?[a-z]?\.|Stk\.\s*\d+\.|\d+\)|[a-z]\)|\([a-z0-9]+\)|\d+\.)\s*/i, "");
  if (u.flags.includes("amendment")) return "amendment";
  if (u.flags.includes("repeal") && !MODAL.test(words)) return "repeal";
  if (u.flags.includes("commencement") && !MODAL.test(words.replace(/træder i kraft[^.]*|enters? into force[^.]*/gi, ""))) return "commencement";
  return null;
}

/** A reader's reason for "no rule here" as one of a few plain words (its own words when none fits → "other"). */
export function noRuleCode(reason: string): string {
  const r = reason.toLowerCase();
  if (/heading|overskrift|title/.test(r)) return "heading";
  if (/commence|ikrafttr|træder i kraft|enter(s)? into force|in force/.test(r)) return "commencement";
  if (/repeal|ophæv/.test(r)) return "repeal";
  if (/amend|ændring/.test(r)) return "amendment";
  if (/authori[sz]|bemynd|empower|delegat/.test(r)) return "authorisation";
  if (/purpose|formål|objective/.test(r)) return "purpose";
  if (/procedur|administrat/.test(r)) return "procedure";
  if (/defin/.test(r)) return "definition";
  if (/scope|anvendelsesområde|applies to|appl(y|ies)/.test(r)) return "scope";
  return "other";
}

/* ── Definitions ─────────────────────────────────────────────────────────────────────────────────────────── */

export type FoundDefinition = { unitKey: string; term: string; text: string; quote: string };

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const ITEM_DEF = [
  /^(?:\d{1,3}\)|\(\d{1,3}\)|[a-z]\))\s*»([^«]{2,80})«\s*:?\s*(.{8,})$/s,
  /^(?:\d{1,3}\)|\(\d{1,3}\)|[a-z]\))\s*[‘'"“]([^’'"”]{2,80})[’'"”][^:]{0,40}?\s*(?:means|betyder|:)\s*(.{8,})$/s,
  /^(?:\d{1,3}\)|[a-z]\))\s*([\p{Lu}][^:]{1,80}):\s*(.{8,})$/su,
];
const PROSE_DEF = [
  /\bved\s+(?:en\s+|et\s+)?»?([^,.»«]{2,60}?)«?\s+forstås\s+([^.]{8,}?)\./giu,
  /[‘'"“»]([^’'"”«]{2,60})[’'"”«]\s+(?:means|betyder)\s+([^.;]{8,})/giu,
  /\b([\p{L}-]{3,40})\s+betegnes i denne \p{L}+ som\s+([^.]{2,60})\./giu,
];

/**
 * Terms the text defines. In a definitions unit ("I denne lov forstås ved: …", "For the purposes of this Regulation:")
 * each numbered item is a term; elsewhere a sentence of the form "ved X forstås Y" / "‘X’ means Y". The quote is the
 * item's or sentence's exact words.
 */
export function definitionsIn(units: Pick<Unit, "key" | "parentKey" | "flags" | "own" | "kind">[]): FoundDefinition[] {
  const out: FoundDefinition[] = [];
  const seen = new Set<string>();
  const add = (d: FoundDefinition) => {
    const k = d.term.toLowerCase();
    if (seen.has(k) || d.term.length < 2) return;
    seen.add(k);
    out.push(d);
  };
  const defParents = new Set(units.filter((u) => u.flags.includes("definition")).map((u) => u.key));
  for (const u of units) {
    const own = u.own.trim();
    if (u.parentKey && defParents.has(u.parentKey) && (u.kind === "nr" || u.kind === "point" || u.kind === "litra")) {
      for (const re of ITEM_DEF) {
        const m = re.exec(own);
        if (m) { add({ unitKey: u.key, term: cap(m[1].trim()), text: m[2].trim().replace(/[;,.]\s*(og|and|eller|or)?$/i, "").trim(), quote: own }); break; }
      }
      continue;
    }
    if (!PROVISION_KINDS.has(u.kind)) continue;
    for (const re of PROSE_DEF) {
      re.lastIndex = 0;
      for (const m of own.matchAll(re)) {
        const term = m[1].trim();
        if (/^(den|det|de|this|that|the)$/i.test(term)) continue;
        add({ unitKey: u.key, term: cap(term), text: m[2].trim(), quote: m[0].trim() });
      }
    }
  }
  return out;
}

/* ── Passages for the model ──────────────────────────────────────────────────────────────────────────────── */

export type Passage = { text: string; start: number; end: number; tops: string[]; units: { key: string; label: string }[] };

/**
 * What one model call reads: consecutive top units (a § with its stykker and numbers, an article with its paragraphs
 * and points) up to `max` characters, never cut inside a unit unless the unit alone is longer.
 */
export function passagesFor(text: string, units: Pick<Unit, "key" | "label" | "kind" | "top" | "start" | "end">[], max = 5000): Passage[] {
  // A top unit with top units inside it (an annex holding §§) is read through those, not twice.
  const allTops = units.filter((u) => TOP_KINDS.has(u.kind));
  const tops = allTops.filter((t) => !allTops.some((o) => o !== t && o.start > t.start && o.start < t.end));
  const out: Passage[] = [];
  let cur: Passage | null = null;
  const flush = () => { if (cur && cur.text.trim()) out.push(cur); cur = null; };
  for (const t of tops) {
    const members = units.filter((u) => u.top === t.key && PROVISION_KINDS.has(u.kind));
    const span = { start: t.start, end: t.end };
    if (span.end - span.start > max) {
      flush();
      // A very long unit: cut it at its sub-units into pieces of about `max`.
      let s = span.start;
      const cuts = members.filter((m) => m.start > span.start).map((m) => m.start);
      while (s < span.end) {
        let e = Math.min(span.end, s + max);
        const at = cuts.filter((c) => c > s && c <= e).pop();
        if (at && e < span.end) e = at;
        const inside = members.filter((m) => m.start >= s && m.start < e);
        out.push({ text: text.slice(s, e), start: s, end: e, tops: [t.key], units: (inside.length ? inside : [t]).map((m) => ({ key: m.key, label: m.label })) });
        s = e;
      }
      continue;
    }
    if (cur && span.end - cur.start > max) flush();
    if (!cur) cur = { text: "", start: span.start, end: span.end, tops: [], units: [] };
    cur.end = span.end;
    cur.text = text.slice(cur.start, cur.end);
    cur.tops.push(t.key);
    cur.units.push(...(members.length ? members : [t]).map((m) => ({ key: m.key, label: m.label })));
  }
  flush();
  return out;
}

/* ── Coverage and the completeness report ────────────────────────────────────────────────────────────────── */

export type CoverageUnit = { key: string; kind: UnitKind; parentKey: string | null; top: string; flags: Flag[]; note: string | null; chapter: string | null };
export type CoverageRule = { unitKey: string | null; kind: string; status: string; confidence: number | null };

export type CompletenessReport = {
  units: number; withRules: number; definitions: number; noRule: Record<string, number>; headings: number; context: number;
  open: string[]; accounted: number; allAccounted: boolean;
  rules: number; definitionTerms: number; lowConfidence: number;
  flagged: Record<"deadline" | "penalty" | "exception" | "scope" | "definition", { units: number; covered: number }>;
};

const ITEM_KINDS: ReadonlySet<UnitKind> = new Set(["nr", "litra", "point", "subpoint"]);
const under = (child: string, parent: string) => child.startsWith(`${parent}, `) || child.startsWith(`${parent}(`);

/** Each unit's state. A rule on a unit covers the units above it; a rule on a § or stykke covers its numbered items. */
export function unitStates(units: CoverageUnit[], rules: CoverageRule[]): Map<string, UnitState> {
  const live = rules.filter((r) => r.unitKey && r.status !== "dropped");
  const ruleKeys = live.filter((r) => r.kind !== "definition").map((r) => r.unitKey!);
  const defKeys = live.filter((r) => r.kind === "definition").map((r) => r.unitKey!);
  const out = new Map<string, UnitState>();
  // A rule on a unit covers the units above it, and the numbers/letters directly under it (not other stykker).
  const itemsOf = (u: CoverageUnit, k: string) => ITEM_KINDS.has(u.kind) && under(u.key, k) && /^((, (nr\.|litra) [^,]+)|\([a-z]+\)|\((i|ii|iii|iv|v|vi|vii|viii|ix|x)\))+$/.test(u.key.slice(k.length));
  const hasIn = (keys: string[], u: CoverageUnit) => keys.some((k) => k === u.key || under(k, u.key) || itemsOf(u, k));
  for (const u of units) {
    if (hasIn(ruleKeys, u)) out.set(u.key, "ruled");
    else if (hasIn(defKeys, u)) out.set(u.key, "definition");
    else if (u.kind === "chapter" || u.kind === "section" || u.kind === "heading" || u.kind === "preamble") out.set(u.key, "heading");
    else if (u.kind === "recital") out.set(u.key, "context");
    else if (u.note) out.set(u.key, "no_rule");
    else out.set(u.key, "open");
  }
  // A § whose own words only introduce its stykker ("§ 1" over "Stk. 1. …") is covered when all its parts are.
  for (const u of units) {
    if (out.get(u.key) !== "open" || !PROVISION_KINDS.has(u.kind)) continue;
    const parts = units.filter((x) => x.parentKey === u.key);
    if (parts.length && parts.every((p) => out.get(p.key) !== "open")) out.set(u.key, parts.some((p) => out.get(p.key) === "ruled") ? "ruled" : "no_rule");
  }
  return out;
}

export function coverageOf(units: CoverageUnit[], rules: CoverageRule[]): CompletenessReport {
  const states = unitStates(units, rules);
  const count = (s: UnitState) => [...states.values()].filter((x) => x === s).length;
  const noRule: Record<string, number> = {};
  for (const u of units) if (states.get(u.key) === "no_rule") { const k = u.note ?? "other"; noRule[k] = (noRule[k] ?? 0) + 1; }
  const open = units.filter((u) => states.get(u.key) === "open").map((u) => u.key);
  const live = rules.filter((r) => r.status !== "dropped");
  const flagged = {} as CompletenessReport["flagged"];
  for (const f of ["deadline", "penalty", "exception", "scope", "definition"] as const) {
    const fu = units.filter((u) => u.flags.includes(f) && PROVISION_KINDS.has(u.kind));
    flagged[f] = { units: fu.length, covered: fu.filter((u) => { const s = states.get(u.key); return s === "ruled" || s === "definition" || s === "no_rule"; }).length };
  }
  return {
    units: units.length, withRules: count("ruled"), definitions: count("definition"), noRule, headings: count("heading"), context: count("context"),
    open, accounted: units.length - open.length, allAccounted: open.length === 0,
    rules: live.filter((r) => r.kind !== "definition").length, definitionTerms: live.filter((r) => r.kind === "definition").length,
    lowConfidence: live.filter((r) => r.confidence != null && r.confidence < LOW_CONFIDENCE).length, flagged,
  };
}

export const LOW_CONFIDENCE = 0.55;

/**
 * Pass 3: the top units to read again, most important first — those with open units, those whose deadline, penalty
 * or definition wording has no rule or definition yet, and those holding a rule read with low confidence.
 */
export function rereadList(units: CoverageUnit[], rules: (CoverageRule & { unitKey: string | null })[], max = 60): string[] {
  const states = unitStates(units, rules);
  const score = new Map<string, number>();
  const bump = (top: string, n: number) => { if (top) score.set(top, (score.get(top) ?? 0) + n); };
  for (const u of units) {
    if (!PROVISION_KINDS.has(u.kind)) continue;
    const s = states.get(u.key);
    if (s === "open") bump(u.top, 3);
    if ((u.flags.includes("deadline") || u.flags.includes("penalty")) && s !== "ruled") bump(u.top, 2);
    if (u.flags.includes("definition") && s !== "definition" && s !== "ruled") bump(u.top, 2);
  }
  const byKey = new Map(units.map((u) => [u.key, u]));
  for (const r of rules) {
    if (r.status === "dropped" || r.confidence == null || r.confidence >= LOW_CONFIDENCE || !r.unitKey) continue;
    bump(byKey.get(r.unitKey)?.top ?? "", 1);
  }
  return [...score.entries()].filter(([k]) => byKey.has(k)).sort((a, b) => b[1] - a[1] || (byKey.get(a[0])!.key.localeCompare(byKey.get(b[0])!.key, "da", { numeric: true }))).slice(0, max).map(([k]) => k);
}

/* ── Where in the official PDF ───────────────────────────────────────────────────────────────────────────── */

const fold = (s: string) => s.normalize("NFKC").replace(/­/g, "").replace(/-\s*\n\s*/g, "").replace(/\s+/g, " ").toLowerCase().trim();

/** The 1-based page of `pages` the words are on (their first ~70 characters, spacing and hyphenation aside), or null. */
export function pageOf(pages: string[], words: string): number | null {
  const probe = fold(words).replace(/^(§\s*\d+\s?[a-z]?\.|stk\.\s*\d+\.|\d+\)|\([a-z0-9]+\)|\d+\.)\s*/, "").slice(0, 70);
  if (probe.length < 12) return null;
  const folded = pages.map(fold);
  for (let i = 0; i < folded.length; i++) if (folded[i].includes(probe)) return i + 1;
  // Across a page break: the start on one page.
  const short = probe.slice(0, 32);
  for (let i = 0; i < folded.length; i++) if (folded[i].includes(short)) return i + 1;
  return null;
}

/* ── Check for changes ───────────────────────────────────────────────────────────────────────────────────── */

export type UnitDiff<T extends { key: string; hash: string }> = { added: T[]; changed: { from: T; to: T }[]; removed: T[]; unchanged: T[] };

/** Units of a new version against the old: by key, and "changed" when their words (hash) moved. */
export function diffUnits<T extends { key: string; hash: string }>(old: T[], next: T[]): UnitDiff<T> {
  const before = new Map(old.map((u) => [u.key, u]));
  const out: UnitDiff<T> = { added: [], changed: [], removed: [], unchanged: [] };
  const seen = new Set<string>();
  for (const u of next) {
    const o = before.get(u.key);
    seen.add(u.key);
    if (!o) out.added.push(u);
    else if (o.hash !== u.hash) out.changed.push({ from: o, to: u });
    else out.unchanged.push(u);
  }
  for (const o of old) if (!seen.has(o.key)) out.removed.push(o);
  return out;
}

/** The top units a re-read must cover after a change: changed or added units' tops (removed ones only retire rules). */
export function topsToReread(diff: UnitDiff<{ key: string; hash: string; top?: string; kind?: string }>): string[] {
  const tops = new Set<string>();
  const structure = (u: { kind?: string }) => !!u.kind && /^(chapter|section|heading|preamble)$/.test(u.kind);
  for (const u of diff.added) if (!structure(u)) tops.add(u.top || u.key);
  for (const c of diff.changed) if (!structure(c.to)) tops.add(c.to.top || c.to.key);
  return [...tops];
}

/* ── Guidance as interpretation ──────────────────────────────────────────────────────────────────────────── */

/**
 * Guidance passages that talk about a unit of the act ("lovens § 5", "§ 5, stk. 2", "artikel 6"), keyed by the act's
 * top unit. Each link keeps the passage's exact words so it can be shown and opened.
 */
export function interpretationLinks(chunks: { id: string; sourceId: string; text: string }[], topKeys: Set<string>, family: "dk" | "eu" | "generic"): Map<string, { chunkId: string; sourceId: string; quote: string }[]> {
  const out = new Map<string, { chunkId: string; sourceId: string; quote: string }[]>();
  const re = family === "eu" ? /\b(?:Article|Artikel|artikel)\s+(\d+)/g : /(?:lovens|bekendtgørelsens|vedtægtens|loven)?\s*§\s*(\d+(?:\s?[a-z](?![a-zæøå]))?)(?![\d])/g;
  for (const c of chunks) {
    const keys = new Set<string>();
    for (const m of c.text.matchAll(re)) {
      const key = family === "eu" ? `Art. ${m[1]}` : `§ ${m[1].replace(/\s+/g, " ")}`;
      if (topKeys.has(key)) keys.add(key);
    }
    for (const k of keys) {
      const at = c.text.search(family === "eu" ? new RegExp(`(Article|Artikel|artikel)\\s+${k.slice(5)}\\b`) : new RegExp(`§\\s*${k.slice(2).replace(" ", "\\s?")}\\b`));
      const from = Math.max(0, c.text.lastIndexOf(". ", at) + 1);
      const quote = c.text.slice(from, Math.min(c.text.length, from + 400)).trim();
      const list = out.get(k) ?? [];
      if (list.length < 3) list.push({ chunkId: c.id, sourceId: c.sourceId, quote });
      out.set(k, list);
    }
  }
  return out;
}

/** The hash a unit's words get (same as pass 1), for tests and re-checks. */
export const unitHash = (words: string) => hashText(words.replace(/\s+/g, " ").trim());

/** Does the quote really stand in the text? (The verbatim check every rule and definition passes.) */
export function quoteIn(text: string, quote: string): { start: number; end: number } | null {
  return locate(text, quote, { allowPrefix: true });
}
