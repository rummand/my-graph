/**
 * Corpora (pure, unit-tested): the vocabulary, reading rules out of a passage (parsing what the model returned and
 * keeping only rules whose quote really is in the passage), grouping by section, deduplicating across sources, and the
 * diff a new version of a law proposes (added, changed, removed).
 */
import { z } from "zod";
import { clip, locate, overlap } from "@/lib/compliance/text";

/**
 * What a rule set is, in words people use: a law (Danish act, executive order, EU regulation), an agreement, house
 * rules, a school's or institution's rules, guidelines (an authority's guidance, a standard) or our own rules. The
 * earlier kinds (legislation, regulation, internal governance …) are still read and shown as their new names.
 */
export const RULE_SET_KINDS = ["law", "agreement", "house_rules", "school", "guidelines", "own_rules"] as const;
export const LEGACY_KINDS = ["legislation", "regulation", "internal_governance", "guardrail", "policy", "standard", "other"] as const;
export const CORPUS_KINDS = [...RULE_SET_KINDS, ...LEGACY_KINDS] as const;
export type CorpusKind = (typeof CORPUS_KINDS)[number];
export type RuleSetKind = (typeof RULE_SET_KINDS)[number];

const LEGACY_TO_KIND: Record<string, RuleSetKind> = {
  legislation: "law", regulation: "law", internal_governance: "own_rules", guardrail: "own_rules", policy: "own_rules", standard: "guidelines", other: "own_rules",
};

/** The kind as one of the six names people see (an earlier kind becomes its new name). */
export function ruleSetKind(kind: string | null | undefined): RuleSetKind {
  if ((RULE_SET_KINDS as readonly string[]).includes(kind ?? "")) return kind as RuleSetKind;
  return LEGACY_TO_KIND[kind ?? ""] ?? "own_rules";
}
export const BINDINGS = ["mandatory", "advisory"] as const;
export type Binding = (typeof BINDINGS)[number];
export const CORPUS_STATUSES = ["draft", "active", "retired"] as const;
export type CorpusStatus = (typeof CORPUS_STATUSES)[number];
export const MODALITIES = ["must", "must_not", "should", "should_not", "may"] as const;
export type Modality = (typeof MODALITIES)[number];
export const SEVERITIES = ["blocker", "major", "minor", "info"] as const;
export type Severity = (typeof SEVERITIES)[number];
export const RULE_STATUSES = ["proposed", "active", "retired", "dropped"] as const;
export type RuleStatus = (typeof RULE_STATUSES)[number];
export const SOURCE_ROLES = ["text", "interpretation", "supporting"] as const;
export type SourceRole = (typeof SOURCE_ROLES)[number];
export const TARGET_TYPES = ["wiki", "artifact", "message", "change_set", "node"] as const;
export type TargetType = (typeof TARGET_TYPES)[number];

/** Where a corpus (or one rule) applies. Empty lists mean "no limit on that axis"; `all` means everywhere. */
export type CorpusScope = {
  all?: boolean;
  targetTypes?: TargetType[];
  nodeKinds?: string[];
  tags?: string[];
  wikiSlugs?: string[];
  artifactKinds?: string[];
};

export const scopeSchema = z.object({
  all: z.boolean().optional(),
  targetTypes: z.array(z.enum(TARGET_TYPES)).max(5).optional(),
  nodeKinds: z.array(z.string().trim().min(1).max(60)).max(30).optional(),
  tags: z.array(z.string().trim().min(1).max(60)).max(30).optional(),
  wikiSlugs: z.array(z.string().trim().min(1).max(120)).max(50).optional(),
  artifactKinds: z.array(z.string().trim().min(1).max(40)).max(10).optional(),
});

export function readScope(raw: unknown): CorpusScope {
  const r = scopeSchema.safeParse(raw ?? {});
  return r.success ? r.data : { all: true };
}

/**
 * The part of a rule's scope that says where it applies (kinds of text, wiki sections, document kinds, node kinds).
 * Topic words a model attaches to a rule ("measurement data") are descriptions, not limits: a page doesn't carry
 * tags, so they would silently switch the rule off. Only people set tag limits, on the corpus.
 */
export function structuralScope(s: CorpusScope): CorpusScope {
  const out: CorpusScope = {};
  if (s.targetTypes?.length) out.targetTypes = s.targetTypes;
  if (s.wikiSlugs?.length) out.wikiSlugs = s.wikiSlugs;
  if (s.artifactKinds?.length) out.artifactKinds = s.artifactKinds;
  if (s.nodeKinds?.length) out.nodeKinds = s.nodeKinds;
  return out;
}

/** The default severity for a rule of a corpus: what breaking it costs. */
export function defaultSeverity(modality: Modality, binding: Binding): Severity {
  if (binding === "advisory") return modality === "may" ? "info" : "minor";
  if (modality === "must" || modality === "must_not") return "major";
  if (modality === "should" || modality === "should_not") return "minor";
  return "info";
}

/* ── References and sections ────────────────────────────────────────────────────────────────────────────── */

/** "§ 16, stk. 2" and "§16 Stk 2" are the same reference: compare them folded. */
export function normalizeRef(ref: string): string {
  return ref.toLowerCase()
    .replace(/§\s*/g, "§")
    .replace(/\bstk\.?\s*/g, "stk ")
    .replace(/\bnr\.?\s*/g, "nr ")
    .replace(/[,;:]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The section a rule belongs to on the corpus page: "§ 16" for "§16 stk. 2", "ADR-4" for "ADR-4.2", "Kapitel 3" … */
export function sectionOf(ref: string): string {
  const r = ref.trim();
  // "§ 16 a" is its own paragraph; the "s" of "stk." is not.
  const para = r.match(/§\s*(\d+)(?:\s*([a-z])\b(?!\.))?/i);
  if (para) return `§ ${para[1]}${para[2] ? ` ${para[2].toLowerCase()}` : ""}`;
  const art = r.match(/\b(art(?:ikel|icle)?\.?)\s*(\d+)/i);
  if (art) return `${/^art/i.test(art[1]) && art[1].length <= 4 ? "Art." : art[1]} ${art[2]}`;
  const dotted = r.match(/^([A-Za-zÆØÅæøå]+)[-\s]?(\d+)(?:\.\d+)+/);
  if (dotted) return `${dotted[1].toUpperCase()}-${dotted[2]}`;
  const chap = r.match(/\b(kapitel|chapter|afsnit|section)\s*(\d+|[IVX]+)/i);
  if (chap) return `${chap[1][0].toUpperCase()}${chap[1].slice(1).toLowerCase()} ${chap[2]}`;
  const head = r.match(/^([A-Za-zÆØÅæøå]+[-\s]?\d+)/);
  return head ? head[1] : r.split(/\s+/)[0] || r;
}

/** Natural order of sections ("§ 2" before "§ 16"). */
export function compareSections(a: string, b: string): number {
  return a.localeCompare(b, "da", { numeric: true, sensitivity: "base" });
}

/* ── Reading rules out of a passage ─────────────────────────────────────────────────────────────────────── */

export type RuleCandidate = {
  ref: string; title: string; text: string; modality: Modality; quote: string; checkHint: string | null;
  severity: Severity; appliesTo: CorpusScope;
  /** Where the quote sits in the passage it was read from. */
  quoteStart: number; quoteEnd: number;
  sourceId?: string; chunkId?: string;
};

const modalityAlias: Record<string, Modality> = {
  must: "must", shall: "must", required: "must", skal: "must",
  must_not: "must_not", "must not": "must_not", shall_not: "must_not", "shall not": "must_not", may_not: "must_not", "må ikke": "must_not", forbidden: "must_not",
  should: "should", bør: "should", recommended: "should",
  should_not: "should_not", "should not": "should_not", "bør ikke": "should_not",
  may: "may", kan: "may", "må": "may", optional: "may",
};

export function readModality(raw: unknown): Modality | null {
  if (typeof raw !== "string") return null;
  return modalityAlias[raw.trim().toLowerCase().replace(/-/g, "_")] ?? modalityAlias[raw.trim().toLowerCase()] ?? null;
}

const rawRule = z.object({
  ref: z.string().trim().min(1).max(80),
  title: z.string().trim().max(160).optional().default(""),
  text: z.string().trim().min(8).max(800),
  modality: z.unknown(),
  quote: z.string().trim().min(8).max(1600),
  check_hint: z.string().trim().max(600).optional().nullable(),
  checkHint: z.string().trim().max(600).optional().nullable(),
  severity: z.unknown().optional(),
  applies_to: z.unknown().optional(),
});

/**
 * Parse the model's answer for one passage into rule candidates. A rule is kept only when its quote is found in the
 * passage (exactly, or ignoring spacing/case) and it has a modality; everything else is dropped with a reason.
 */
export function parseExtraction(raw: unknown, passage: string, opts: { binding: Binding }): { rules: RuleCandidate[]; dropped: { ref: string; why: string }[] } {
  const list = Array.isArray(raw) ? raw : (raw && typeof raw === "object" && Array.isArray((raw as { rules?: unknown }).rules)) ? (raw as { rules: unknown[] }).rules : null;
  if (!list) throw new Error("Expected { \"rules\": [...] }.");
  const rules: RuleCandidate[] = [];
  const dropped: { ref: string; why: string }[] = [];
  for (const item of list.slice(0, 40)) {
    const r = rawRule.safeParse(item);
    if (!r.success) { dropped.push({ ref: String((item as { ref?: unknown })?.ref ?? "?"), why: "incomplete" }); continue; }
    const modality = readModality(r.data.modality);
    if (!modality) { dropped.push({ ref: r.data.ref, why: "no modality" }); continue; }
    const at = locate(passage, r.data.quote, { allowPrefix: true });
    if (!at) { dropped.push({ ref: r.data.ref, why: "quote not in the text" }); continue; }
    const sev = typeof r.data.severity === "string" && (SEVERITIES as readonly string[]).includes(r.data.severity) ? (r.data.severity as Severity) : defaultSeverity(modality, opts.binding);
    rules.push({
      ref: clip(r.data.ref, 80),
      title: clip(r.data.title || r.data.text, 120),
      text: r.data.text,
      modality,
      quote: passage.slice(at.start, at.end),
      checkHint: r.data.check_hint ?? r.data.checkHint ?? null,
      severity: opts.binding === "advisory" && sev === "blocker" ? "major" : sev,
      appliesTo: structuralScope(readScope(r.data.applies_to)),
      quoteStart: at.start,
      quoteEnd: at.end,
    });
  }
  return { rules, dropped };
}

/* ── Deduplicating ──────────────────────────────────────────────────────────────────────────────────────── */

export type RuleLike = { ref: string; text: string; quote?: string | null; modality: string };

/** The same rule read twice (two sources, two overlapping passages, the guide quoting the law). */
export function sameRule(a: RuleLike, b: RuleLike): boolean {
  const sameRef = normalizeRef(a.ref) === normalizeRef(b.ref);
  const textClose = overlap(a.text, b.text);
  const quoteClose = a.quote && b.quote ? overlap(a.quote, b.quote) : 0;
  if (sameRef && a.modality === b.modality && (textClose >= 0.45 || quoteClose >= 0.6)) return true;
  if (quoteClose >= 0.85) return true;
  return textClose >= 0.8 && a.modality === b.modality;
}

/** Drop candidates that repeat each other or a rule the corpus already has (proposed or active). First one wins. */
export function dedupeRules<T extends RuleLike>(candidates: T[], existing: RuleLike[] = []): { kept: T[]; duplicates: T[] } {
  const kept: T[] = [];
  const duplicates: T[] = [];
  for (const c of candidates) {
    if (existing.some((e) => sameRule(c, e)) || kept.some((k) => sameRule(c, k))) duplicates.push(c);
    else kept.push(c);
  }
  return { kept, duplicates };
}

/* ── A new version: what changed ────────────────────────────────────────────────────────────────────────── */

export type VersionDiff<C, R> = { added: C[]; changed: { from: R; to: C }[]; removed: R[]; unchanged: { from: R; to: C }[] };

/**
 * Compare the rules read from a new version with the rules in force: matched by reference (or, failing that, by
 * wording); a match whose wording or modality moved is "changed", a rule nothing matches is "removed".
 */
export function diffVersion<C extends RuleLike, R extends RuleLike & { id: string }>(current: R[], next: C[]): VersionDiff<C, R> {
  const out: VersionDiff<C, R> = { added: [], changed: [], removed: [], unchanged: [] };
  const used = new Set<string>();
  for (const c of next) {
    const byRef = current.find((r) => !used.has(r.id) && normalizeRef(r.ref) === normalizeRef(c.ref));
    const match = byRef ?? current.find((r) => !used.has(r.id) && sameRule(r, c));
    if (!match) { out.added.push(c); continue; }
    used.add(match.id);
    const same = match.modality === c.modality && (overlap(match.text, c.text) >= 0.7 || (!!match.quote && !!c.quote && overlap(match.quote, c.quote) >= 0.9));
    (same ? out.unchanged : out.changed).push({ from: match, to: c });
  }
  for (const r of current) if (!used.has(r.id)) out.removed.push(r);
  return out;
}

/* ── Splitting a source into passages for reading ───────────────────────────────────────────────────────── */

export type Passage = { chunkIds: string[]; text: string; offsets: { chunkId: string; start: number; end: number; locator: Record<string, unknown> }[] };

/** Group a source's chunks into passages of about `max` characters (fewer model calls, rules not cut in half). */
export function passagesOf(chunks: { id: string; text: string; locator: Record<string, unknown> }[], max = 6000): Passage[] {
  const out: Passage[] = [];
  let cur: Passage = { chunkIds: [], text: "", offsets: [] };
  for (const c of chunks) {
    if (cur.text && cur.text.length + c.text.length + 2 > max) { out.push(cur); cur = { chunkIds: [], text: "", offsets: [] }; }
    const start = cur.text ? cur.text.length + 2 : 0;
    cur.text = cur.text ? `${cur.text}\n\n${c.text}` : c.text;
    cur.chunkIds.push(c.id);
    cur.offsets.push({ chunkId: c.id, start, end: start + c.text.length, locator: c.locator });
  }
  if (cur.text) out.push(cur);
  return out;
}

/** The chunk a quote sits in, and the quote's place inside that chunk. */
export function chunkOfQuote(p: Passage, start: number, end: number): { chunkId: string; locator: Record<string, unknown> } | null {
  const o = p.offsets.find((x) => start >= x.start && start < x.end) ?? p.offsets[0];
  if (!o) return null;
  const base = typeof o.locator.charStart === "number" ? (o.locator.charStart as number) : null;
  const locator: Record<string, unknown> = { ...o.locator };
  if (base !== null) { locator.charStart = base + (start - o.start); locator.charEnd = base + (Math.min(end, o.end) - o.start); }
  return { chunkId: o.chunkId, locator };
}

/** "12 rules, 3 proposed": the coverage line's numbers. */
export function coverage(rules: { status: string }[]): { active: number; proposed: number; retired: number } {
  return {
    active: rules.filter((r) => r.status === "active").length,
    proposed: rules.filter((r) => r.status === "proposed").length,
    retired: rules.filter((r) => r.status === "retired").length,
  };
}
