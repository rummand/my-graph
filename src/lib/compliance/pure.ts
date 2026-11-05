/**
 * The compliance engine's pure parts (unit-tested): which corpora and rules apply to a text, the cache, mapping the
 * model's verdicts back onto exact places in the text, and a finding's lifecycle (open → fixed, or accepted with a
 * reason) across checks.
 */
import { z } from "zod";
import type { CorpusScope, Severity, TargetType } from "@/lib/corpus/pure";
import { clip, hashText, locate, type Paragraph } from "./text";

export const VERDICTS = ["compliant", "non_compliant", "missing", "unclear"] as const;
export type Verdict = (typeof VERDICTS)[number];
export const FINDING_STATUSES = ["open", "fixed", "accepted"] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

/** What is being checked, for scope decisions. */
export type CheckContext = {
  targetType: TargetType;
  artifactKind?: string | null;
  nodeKinds?: string[];
  tags?: string[];
  wikiSlug?: string | null;
};

/* ── Scope ──────────────────────────────────────────────────────────────────────────────────────────────── */

const AXIS_TYPES: Record<"wikiSlugs" | "artifactKinds" | "nodeKinds", TargetType[]> = {
  wikiSlugs: ["wiki"], artifactKinds: ["artifact"], nodeKinds: ["node", "change_set"],
};

const has = (l: unknown[] | undefined) => Array.isArray(l) && l.length > 0;
const lower = (l: string[] | undefined) => (l ?? []).map((x) => x.toLowerCase());

/**
 * Does a corpus (or rule) scope cover this text? `all` (or no limits) covers everything. Target types limit by type;
 * a wiki section, document kind or node kind limits that type to those (and, without explicit target types, means
 * only that type); tags need one tag in common.
 */
export function scopeApplies(scope: CorpusScope | null | undefined, ctx: CheckContext): boolean {
  const s = scope ?? {};
  const axes = (["wikiSlugs", "artifactKinds", "nodeKinds"] as const).filter((a) => has(s[a]));
  if (s.all && !has(s.targetTypes) && !axes.length && !has(s.tags)) return true;
  let types: TargetType[] | null = has(s.targetTypes) ? s.targetTypes! : null;
  if (!types && axes.length) types = [...new Set(axes.flatMap((a) => AXIS_TYPES[a]))];
  if (types && !types.includes(ctx.targetType)) return false;
  if (has(s.wikiSlugs) && ctx.targetType === "wiki") {
    const slug = (ctx.wikiSlug ?? "").toLowerCase();
    if (!lower(s.wikiSlugs).some((w) => slug === w || slug.startsWith(`${w}-`) || slug.startsWith(`${w}/`))) return false;
  }
  if (has(s.artifactKinds) && ctx.targetType === "artifact" && !lower(s.artifactKinds).includes((ctx.artifactKind ?? "").toLowerCase())) return false;
  if (has(s.nodeKinds) && (ctx.targetType === "node" || ctx.targetType === "change_set")) {
    const kinds = lower(ctx.nodeKinds);
    if (!lower(s.nodeKinds).some((k) => kinds.includes(k))) return false;
  }
  if (has(s.tags)) {
    const tags = lower(ctx.tags);
    if (!lower(s.tags).some((t) => tags.includes(t))) return false;
  }
  return true;
}

/**
 * The corpora a text is checked against: the page's own choice when it made one, else the graph's default set (or,
 * without one, every corpus marked "check by default"); only active corpora in force today whose scope covers the text
 * (a corpus a page picked explicitly is checked even outside its scope).
 */
export function pickCorpora<T extends { id: string; status: string; scope: CorpusScope; checkByDefault: boolean; effectiveFrom?: Date | string | null; effectiveTo?: Date | string | null }>(
  corpora: T[], ctx: CheckContext, choice: { page: string[] | null; graph: string[] | null }, now = new Date(),
): T[] {
  const inForce = (c: T) => c.status === "active"
    && (!c.effectiveFrom || new Date(c.effectiveFrom) <= now)
    && (!c.effectiveTo || new Date(c.effectiveTo) > now);
  if (choice.page) return corpora.filter((c) => choice.page!.includes(c.id) && inForce(c));
  const base = choice.graph ? corpora.filter((c) => choice.graph!.includes(c.id)) : corpora.filter((c) => c.checkByDefault);
  return base.filter((c) => inForce(c) && scopeApplies(c.scope, ctx));
}

/** The rules to put in front of the model: all of them when few, else the closest `cap` (blockers first on ties). */
export function selectRules<T extends { id: string; score: number; severity: Severity | string }>(rules: T[], cap: number): T[] {
  if (rules.length <= cap) return rules;
  const weight = (s: string) => (s === "blocker" ? 0.03 : s === "major" ? 0.015 : 0);
  return [...rules].sort((a, b) => b.score + weight(b.severity) - (a.score + weight(a.severity))).slice(0, cap);
}

/**
 * A chat answer none of the rules is close to (best cosine similarity under `min`; bge-m3, calibrated with
 * scripts/assistant-eval.ts compliance: everyday answers score 0.42–0.46 against a law's rules, answers about its
 * subject 0.54+). Such an answer isn't sent to the model at all. Never true when some rule has no embedding yet
 * (`unembedded`, the score activeRules gives those), or when there are no scores. Pure.
 */
export const MESSAGE_RULE_MIN = 0.48;
export function nothingClose(scores: number[], opts: { min?: number; unembedded?: number } = {}): boolean {
  if (!scores.length || scores.some((s) => s === (opts.unembedded ?? 0.3))) return false;
  return Math.max(...scores) < (opts.min ?? MESSAGE_RULE_MIN);
}

/** One version string for a set of corpora's rules: any approved, edited or retired rule changes it. */
export function ruleSetVersion(corpora: { id: string; rulesVersion: number }[]): string {
  return hashText(...[...corpora].sort((a, b) => a.id.localeCompare(b.id)).map((c) => `${c.id}:${c.rulesVersion}`)).slice(0, 16);
}

/* ── Cache ──────────────────────────────────────────────────────────────────────────────────────────────── */

/** A small LRU with a time limit (in-process; a restart only costs a re-check). */
export class TtlCache<V> {
  private map = new Map<string, { v: V; at: number }>();
  constructor(private max = 500, private ttlMs = 6 * 60 * 60 * 1000, private now: () => number = Date.now) {}
  get(k: string): V | undefined {
    const e = this.map.get(k);
    if (!e) return undefined;
    if (this.now() - e.at > this.ttlMs) { this.map.delete(k); return undefined; }
    this.map.delete(k);
    this.map.set(k, e);
    return e.v;
  }
  set(k: string, v: V): void {
    this.map.delete(k);
    this.map.set(k, { v, at: this.now() });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value as string);
  }
  get size() { return this.map.size; }
}

/** The cache key of one paragraph's check: its words, the rules it was checked against, the reader's language. */
export function paragraphKey(p: { graphId: string; ruleSet: string; ruleIds: string[]; locale: string; text: string }): string {
  return hashText("p", p.graphId, p.ruleSet, [...p.ruleIds].sort().join(","), p.locale, p.text);
}

/* ── Verdicts → findings ────────────────────────────────────────────────────────────────────────────────── */

export type Span = { start: number; end: number; text: string; approx?: boolean };

export type FreshFinding = {
  ruleId: string; verdict: Exclude<Verdict, "compliant">; explanation: string; suggestion: string | null;
  span: Span | null; paragraphKey: string | null; fingerprint: string;
};

const rawVerdict = z.object({
  rule: z.union([z.string(), z.number()]),
  paragraph: z.union([z.number(), z.string()]).optional().nullable(),
  verdict: z.string(),
  span: z.string().max(2000).optional().nullable(),
  explanation: z.string().max(1200).optional().nullable(),
  suggestion: z.string().max(2000).optional().nullable(),
});

function readVerdict(v: string): Verdict | null {
  const s = v.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (s === "compliant" || s === "ok" || s === "complies") return "compliant";
  if (s === "non_compliant" || s === "noncompliant" || s === "violation" || s === "conflict" || s === "breaks") return "non_compliant";
  if (s === "missing" || s === "absent" || s === "not_addressed") return "missing";
  if (s === "unclear" || s === "uncertain" || s === "unknown") return "unclear";
  return null;
}

/** `R3` / `3` / a rule id → the rule's id. */
function ruleOf(raw: string | number, ruleIds: string[]): string | null {
  const s = String(raw).trim();
  if (ruleIds.includes(s)) return s;
  const m = s.match(/^R?\s*(\d+)$/i);
  if (m) return ruleIds[Number(m[1]) - 1] ?? null;
  return null;
}

/** The identity of a finding across checks: same rule, same passage (folded), or "missing" for the whole text. */
export function fingerprintOf(ruleId: string, verdict: string, spanText: string | null): string {
  const body = verdict === "missing" || !spanText ? "missing" : spanText.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 300);
  return hashText(ruleId, verdict === "missing" ? "missing" : "text", body);
}

/**
 * Map the model's per-rule verdicts onto the text. Each verdict names a rule (R1…) and a paragraph (P1…); its span is
 * looked up in that paragraph (then anywhere in the text). A span that can't be found falls back to the whole
 * paragraph, marked approximate, so nothing the model said is lost but nothing is underlined that isn't there.
 * Compliant verdicts are dropped (they are not findings).
 */
export function parseVerdicts(raw: unknown, ctx: { paragraphs: Paragraph[]; fullText: string; ruleIds: string[]; allowMissing?: boolean; refs?: string[] }): FreshFinding[] {
  const list = Array.isArray(raw) ? raw : (raw && typeof raw === "object" && Array.isArray((raw as { findings?: unknown }).findings)) ? (raw as { findings: unknown[] }).findings : null;
  if (!list) throw new Error("Expected { \"findings\": [...] }.");
  const out: FreshFinding[] = [];
  const seen = new Set<string>();
  for (const item of list.slice(0, 60)) {
    const r = rawVerdict.safeParse(item);
    if (!r.success) continue;
    const ruleId = ruleOf(r.data.rule, ctx.ruleIds);
    const verdict = readVerdict(r.data.verdict);
    if (!ruleId || !verdict || verdict === "compliant") continue;
    if (verdict === "missing" && !ctx.allowMissing) continue;
    // The prompt's rule ids (R1 …) mean nothing to a reader: say the rule's own reference instead.
    const named = (x: string) => (ctx.refs ? x.replace(/\b(?:rule\s+)?R(\d{1,2})\b/gi, (m, n) => ctx.refs![Number(n) - 1] ?? m) : x);
    const explanation = clip(named((r.data.explanation ?? "").trim()), 900);
    const suggestion = r.data.suggestion?.trim() ? clip(r.data.suggestion.trim(), 1600) : null;
    let span: Span | null = null;
    let pKey: string | null = null;
    if (verdict !== "missing") {
      const pIdx = typeof r.data.paragraph === "number" ? r.data.paragraph : Number(String(r.data.paragraph ?? "").replace(/^P/i, ""));
      const para = Number.isFinite(pIdx) ? ctx.paragraphs[pIdx - 1] : undefined;
      const needle = (r.data.span ?? "").trim();
      if (needle) {
        const inPara = para ? locate(para.text, needle, { allowPrefix: true }) : null;
        if (para && inPara) span = { start: para.start + inPara.start, end: para.start + inPara.end, text: para.text.slice(inPara.start, inPara.end) };
        else {
          const anywhere = locate(ctx.fullText, needle, { allowPrefix: true });
          if (anywhere) span = { start: anywhere.start, end: anywhere.end, text: ctx.fullText.slice(anywhere.start, anywhere.end) };
        }
      }
      if (!span && para) span = { start: para.start, end: para.end, text: clip(para.text, 300), approx: true };
      if (!span) continue; // a conflict nobody can point at is not shown
      const host = ctx.paragraphs.find((p) => span!.start >= p.start && span!.start < p.end) ?? para;
      pKey = host?.key ?? null;
    }
    const fingerprint = fingerprintOf(ruleId, verdict, span?.text ?? null);
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    out.push({ ruleId, verdict, explanation, suggestion, span, paragraphKey: pKey, fingerprint });
  }
  return out;
}

/** A rule the text breaks somewhere is not also "missing": keep the finding that points at the words. */
export function dropRedundantMissing<T extends Pick<FreshFinding, "ruleId" | "verdict">>(list: T[]): T[] {
  const pointed = new Set(list.filter((f) => f.verdict !== "missing").map((f) => f.ruleId));
  return list.filter((f) => f.verdict !== "missing" || !pointed.has(f.ruleId));
}

/** Shift findings cached for a paragraph to where that paragraph sits now (it may have moved). */
export function shiftFindings(found: FreshFinding[], from: number, to: number): FreshFinding[] {
  const d = to - from;
  return d === 0 ? found : found.map((f) => (f.span ? { ...f, span: { ...f.span, start: f.span.start + d, end: f.span.end + d } } : f));
}

/* ── Lifecycle ──────────────────────────────────────────────────────────────────────────────────────────── */

export type StoredFinding = { id: string; fingerprint: string; status: FindingStatus | string; verdict: string };

export type Reconciled = {
  insert: FreshFinding[];
  update: { id: string; finding: FreshFinding }[];
  reopen: { id: string; finding: FreshFinding }[];
  fix: string[];
};

/**
 * One check against what is stored for the same text. A finding seen again keeps its id (and stays accepted if a
 * person accepted it); a fixed one that comes back is reopened; an open one that is gone is fixed. `carry` verdicts
 * (e.g. "missing" when that check was skipped this time) are left as they are.
 */
export function reconcile(stored: StoredFinding[], fresh: FreshFinding[], opts: { carry?: string[] } = {}): Reconciled {
  const out: Reconciled = { insert: [], update: [], reopen: [], fix: [] };
  const byFp = new Map(stored.map((s) => [s.fingerprint, s]));
  const seen = new Set<string>();
  for (const f of fresh) {
    if (seen.has(f.fingerprint)) continue;
    seen.add(f.fingerprint);
    const s = byFp.get(f.fingerprint);
    if (!s) out.insert.push(f);
    else if (s.status === "accepted") continue;
    else if (s.status === "fixed") out.reopen.push({ id: s.id, finding: f });
    else out.update.push({ id: s.id, finding: f });
  }
  for (const s of stored) {
    if (s.status !== "open" || seen.has(s.fingerprint)) continue;
    if (opts.carry?.includes(s.verdict)) continue;
    out.fix.push(s.id);
  }
  return out;
}

/** Accepting a deviation needs a reason a colleague would understand later. */
export function acceptProblem(reason: string): string | null {
  const r = reason.trim();
  if (r.length < 5) return "Say in a few words why this deviation is all right.";
  if (r.length > 1000) return "Keep the reason under 1000 characters.";
  return null;
}

/* ── Summary ────────────────────────────────────────────────────────────────────────────────────────────── */

export type Counts = { blocker: number; major: number; minor: number; info: number; missing: number; open: number; accepted: number };

/** The strip's numbers: open findings by severity, missing obligations, and accepted deviations. */
export function countFindings(list: { status: string; verdict: string; severity: string }[]): Counts {
  const c: Counts = { blocker: 0, major: 0, minor: 0, info: 0, missing: 0, open: 0, accepted: 0 };
  for (const f of list) {
    if (f.status === "accepted") { c.accepted++; continue; }
    if (f.status !== "open") continue;
    c.open++;
    if (f.verdict === "missing") c.missing++;
    if (f.severity === "blocker" || f.severity === "major" || f.severity === "minor" || f.severity === "info") c[f.severity]++;
  }
  return c;
}

/** Severity order for lists: blockers first. */
export const SEVERITY_RANK: Record<string, number> = { blocker: 0, major: 1, minor: 2, info: 3 };
