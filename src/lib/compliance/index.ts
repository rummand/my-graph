/**
 * The compliance engine (server-only). `checkText` checks a text — a wiki page while it is written, a document before
 * it is published, an assistant's answer, a change set's proposals — against the active rules of the corpora that
 * apply to it, and keeps what it found as findings with a lifecycle (open → fixed, or accepted with a reason).
 *
 * Cost, per check:
 *   - one embedding call (mux `embed`) for the text, used to pick the closest rules when a graph has more than
 *     RULE_CAP of them; cached by text;
 *   - at most one `smart` call (`fast` with a small cap for chat answers) for the paragraphs that changed since they
 *     were last checked (at most PARA_CAP of them, 1500 characters each); the prompt puts the instructions and the
 *     rules (in a stable order) first and the text last, so the model's prompt cache keeps them between checks — unchanged paragraphs come from the cache, keyed by their words, the rule set version
 *     and the reader's language;
 *   - at most one `smart` call for "missing" obligations over the whole text, cached by the whole text and asked at
 *     most once a minute per target while someone is typing.
 * Advisory only: nothing is blocked, every finding says why and cites the rule and its source.
 * The checked text is data: it is fenced in the prompt and never followed as instructions.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { complianceFindings, complianceRuns, complianceTargets, corpora, corpusRules, sources, users } from "@/db/schema";
import type { Viewer } from "@/lib/auth";
import * as mux from "@/lib/mux";
import { logActivity } from "@/lib/automations";
import { recordEvent, stampFor } from "@/lib/history/record";
import { localeOf } from "@/lib/assistant/locale";
import { sourceVisibleTo } from "@/lib/ingest/access";
import { activeRules, readScope, structuralScope, type ActiveRule, type CorpusScope, type TargetType } from "@/lib/corpus";
import { checkMessages, missingMessages, type PromptRule } from "./prompt";
import {
  acceptProblem, countFindings, dropRedundantMissing, paragraphKey, parseVerdicts, pickCorpora, reconcile, ruleSetVersion, scopeApplies, nothingClose, selectRules, shiftFindings, TtlCache,
  type CheckContext, type Counts, type FreshFinding, type Span,
} from "./pure";
import { hashText, splitParagraphs, type Paragraph } from "./text";

export * from "./pure";

export const RULE_CAP = 12;
export const PARA_CAP = 10;
const MISSING_EVERY_MS = 60_000;

export class ComplianceError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/* ── Views ──────────────────────────────────────────────────────────────────────────────────────────────── */

export type FindingView = {
  id: string; verdict: string; status: string; explanation: string; suggestion: string | null;
  span: (Span & { block?: string | null }) | null;
  rule: {
    id: string; ref: string; title: string; text: string; modality: string; severity: string; quote: string | null;
    sourceId: string | null; sourceTitle: string | null; locator: Record<string, unknown>; corpusId: string; corpusName: string;
  };
  acceptedReason: string | null; acceptedByName: string | null; acceptedAt: string | null; createdAt: string;
};

export type CheckResult = {
  status: "done" | "skipped" | "unavailable" | "partial";
  corpora: { id: string; name: string }[];
  rulesChecked: number;
  findings: FindingView[];
  counts: Counts;
  cost: { paragraphs: number; cached: number; muxCalls: number; ms: number };
  runId: string | null;
  note?: string | null;
};

const EMPTY_COUNTS: Counts = { blocker: 0, major: 0, minor: 0, info: 0, missing: 0, open: 0, accepted: 0 };

/* ── Caches (in-process) ────────────────────────────────────────────────────────────────────────────────── */

type G = { __mgCompliance?: { paragraphs: TtlCache<FreshFinding[]>; missing: TtlCache<FreshFinding[]>; vectors: TtlCache<number[] | null>; lastMissing: Map<string, number> } };
const g = globalThis as unknown as G;
const caches = g.__mgCompliance ??= {
  paragraphs: new TtlCache<FreshFinding[]>(2000),
  missing: new TtlCache<FreshFinding[]>(300),
  vectors: new TtlCache<number[] | null>(500),
  lastMissing: new Map<string, number>(),
};

/* ── Which corpora ──────────────────────────────────────────────────────────────────────────────────────── */

type CorpusRow = typeof corpora.$inferSelect;

async function choiceFor(v: Viewer, targetType: string, targetId: string | null): Promise<{ page: string[] | null; graph: string[] | null }> {
  const rows = await db.select().from(complianceTargets).where(and(eq(complianceTargets.graphId, v.graphId),
    sql`(${complianceTargets.targetType} = 'graph' and ${complianceTargets.targetId} = '') or (${complianceTargets.targetType} = ${targetType} and ${complianceTargets.targetId} = ${targetId ?? "-"})`));
  const page = rows.find((r) => r.targetType === targetType && r.targetId === (targetId ?? "-"));
  const graph = rows.find((r) => r.targetType === "graph");
  return { page: page ? page.corpusIds : null, graph: graph ? graph.corpusIds : null };
}

/** The corpora a text is checked against, and the graph's corpora to choose from. */
export async function corporaFor(v: Viewer, ctx: CheckContext, targetId: string | null, override?: string[] | null): Promise<{ picked: CorpusRow[]; all: CorpusRow[]; choice: { page: string[] | null; graph: string[] | null } }> {
  const all = await db.select().from(corpora).where(eq(corpora.graphId, v.graphId));
  const choice = override ? { page: override, graph: null } : await choiceFor(v, ctx.targetType, targetId);
  const picked = pickCorpora(all.map((c) => ({ ...c, scope: readScope(c.scope) })), ctx, choice) as unknown as CorpusRow[];
  return { picked, all, choice };
}

/* ── Checking ───────────────────────────────────────────────────────────────────────────────────────────── */

export type CheckInput = {
  text: string;
  targetType: TargetType;
  targetId?: string | null;
  context?: Omit<CheckContext, "targetType"> & {
    title?: string | null; version?: number | null; sensitive?: boolean;
    /** Check against exactly these corpora (a question naming BEK 260). */
    corpusIds?: string[] | null;
    /** Ask for missing obligations too (default true; off for chat answers). */
    missing?: boolean;
    /** Keep the findings (default true when there is a target id). */
    persist?: boolean;
    /** Map spans back onto blocks (documents). */
    blockOf?: (offset: number) => string | null;
    /** mux affinity: checks that share it stay on one model, whose prompt cache keeps the rules (default: the target). */
    affinity?: string | null;
  };
};

/**
 * Which model and how much room. A chat answer is checked after every turn and almost always passes ({"findings":[]},
 * ~8 tokens): a fast model with a small cap (one finding fits); when findings don't fit, the same prompt is asked
 * again with room — the model's prompt cache holds all of it by then, so only the answer costs anything. Pages and
 * documents keep the larger model.
 */
type Ask = { route: mux.MuxRoute; maxTokens: number; roomy?: number };
function askFor(targetType: TargetType): { paragraphs: Ask; missing: Ask } {
  if (targetType === "message") return { paragraphs: { route: "fast", maxTokens: 300, roomy: 2500 }, missing: { route: "fast", maxTokens: 300, roomy: 1500 } };
  return { paragraphs: { route: "smart", maxTokens: 2500 }, missing: { route: "smart", maxTokens: 1500 } };
}

/** One JSON answer: capped first; cut off (it doesn't parse) → the same messages again with room, then as before. */
async function askJson<T>(ask: Ask, messages: mux.MuxMessage[], meta: mux.MuxCallMeta, parse: (raw: unknown) => T): Promise<T> {
  if (ask.roomy) {
    const first = await mux.complete({ route: ask.route, maxTokens: ask.maxTokens, temperature: 0, json: true, messages, meta });
    try { return parse(JSON.parse(stripFence(first.text))); } catch { /* cut off or not JSON: ask again with room */ }
  }
  return mux.completeJson({ route: ask.route, maxTokens: ask.roomy ?? ask.maxTokens, messages, meta, parse });
}

const stripFence = (t: string) => t.replace(/^\s*```(?:json)?\s*|\s*```\s*$/gi, "").trim();

const toPromptRules = (rules: ActiveRule[]): PromptRule[] => rules.map((r, i) => ({ n: i + 1, ref: r.ref, corpus: r.corpusName, modality: r.modality, text: r.text, quote: r.quote, checkHint: r.checkHint }));

/** Check a text against the rules that apply to it. See the module comment for what it costs. */
export async function checkText(v: Viewer, input: CheckInput): Promise<CheckResult> {
  const t0 = Date.now();
  const ctxIn = input.context ?? {};
  const ctx: CheckContext = { targetType: input.targetType, artifactKind: ctxIn.artifactKind, nodeKinds: ctxIn.nodeKinds, tags: ctxIn.tags, wikiSlug: ctxIn.wikiSlug };
  const targetId = input.targetId ?? null;
  const persist = (ctxIn.persist ?? true) && !!targetId;
  const { picked } = await corporaFor(v, ctx, targetId, ctxIn.corpusIds);
  const corpusList = picked.map((c) => ({ id: c.id, name: c.name }));
  const cost = { paragraphs: 0, cached: 0, muxCalls: 0, ms: 0 };
  if (!picked.length) {
    const stored = persist ? await findingsFor(v, input.targetType, targetId!) : [];
    return { status: "skipped", corpora: [], rulesChecked: 0, findings: stored, counts: countOf(stored), cost, runId: null };
  }

  const locale = await localeOf(v.id);
  const text = input.text.slice(0, 60_000);
  const paragraphs = splitParagraphs(text).slice(0, 120);
  const ruleSet = ruleSetVersion(picked);
  const meta: mux.MuxCallMeta = {
    userId: v.id, agent: "my-graph:compliance", graphId: v.graphId, sensitive: !!ctxIn.sensitive, traceId: targetId ?? undefined,
    affinity: ctxIn.affinity ?? (targetId ? `compliance:${input.targetType}:${targetId}` : `compliance:${v.graphId}`),
  };
  const ask = askFor(input.targetType);

  // The rules: all of them when there are few, else the closest to this text.
  const vecKey = hashText("v", text.slice(0, 4000));
  let vec = caches.vectors.get(vecKey);
  if (vec === undefined) {
    vec = (await mux.embed([text.slice(0, 4000) || " "], meta))?.[0] ?? null;
    caches.vectors.set(vecKey, vec);
  }
  const candidates = (await activeRules(v, picked.map((c) => c.id), vec)).filter((r) => {
    const s = structuralScope(r.appliesTo as CorpusScope);
    return !Object.keys(s).length || scopeApplies(s, ctx);
  });
  // A chat answer that no rule is close to (most of them: "Emma swims on Tuesdays") isn't sent to the model.
  const unrelated = input.targetType === "message" && !!vec && !ctxIn.corpusIds?.length && nothingClose(candidates.map((r) => r.score));
  const rules = unrelated ? [] : selectRules(candidates, RULE_CAP);
  const ruleIds = rules.map((r) => r.id);

  const [run] = await db.insert(complianceRuns).values({
    graphId: v.graphId, targetType: input.targetType, targetId: targetId ?? "00000000-0000-0000-0000-000000000000", targetVersion: ctxIn.version ?? null,
    corpusIds: picked.map((c) => c.id), rulesChecked: rules.length, paragraphs: paragraphs.length, createdBy: v.id,
  }).returning({ id: complianceRuns.id });

  const fresh: FreshFinding[] = [];
  const unchecked: Paragraph[] = [];
  let unavailable = false;
  let missingSkipped = false;
  try {
    if (rules.length && paragraphs.length) {
      // Paragraphs: cached ones as they were (moved to where they are now), changed ones to the model.
      const misses: Paragraph[] = [];
      for (const p of paragraphs) {
        const hit = caches.paragraphs.get(paragraphKey({ graphId: v.graphId, ruleSet, ruleIds, locale, text: p.text }));
        if (hit) { fresh.push(...shiftFindings(hit, 0, p.start).map((f) => ({ ...f, paragraphKey: p.key }))); cost.cached++; }
        else if (misses.length < PARA_CAP && p.text.length >= 12) misses.push(p);
        else if (p.text.length >= 12) unchecked.push(p);
      }
      cost.paragraphs = misses.length;
      if (misses.length) {
        const prompt = toPromptRules(rules);
        const found = await askJson(ask.paragraphs, checkMessages({ rules: prompt, paragraphs: misses, locale, targetType: input.targetType, title: ctxIn.title }), meta,
          (raw) => parseVerdicts(raw, { paragraphs: misses, fullText: text, ruleIds, refs: rules.map((r) => `${r.corpusName} ${r.ref}`) }));
        cost.muxCalls++;
        for (const p of misses) {
          const mine = found.filter((f) => f.paragraphKey === p.key);
          // Cached relative to the paragraph, so a paragraph that moves keeps its findings.
          caches.paragraphs.set(paragraphKey({ graphId: v.graphId, ruleSet, ruleIds, locale, text: p.text }), shiftFindings(mine, p.start, 0));
          fresh.push(...mine);
        }
        // A finding whose span the model placed in another paragraph still counts.
        fresh.push(...found.filter((f) => !misses.some((p) => p.key === f.paragraphKey)));
      }
    }

    // Missing obligations, over the whole text: cached by the text, at most once a minute per target while typing.
    const obligations = rules.filter((r) => r.modality === "must" || r.modality === "should");
    if ((ctxIn.missing ?? true) && obligations.length && text.trim().length >= 80) {
      const oIds = obligations.map((r) => r.id);
      const mKey = hashText("m", v.graphId, ruleSet, oIds.join(","), locale, text);
      const hit = caches.missing.get(mKey);
      const throttleKey = `${v.graphId}:${input.targetType}:${targetId ?? text.slice(0, 50)}`;
      const last = caches.lastMissing.get(throttleKey) ?? 0;
      if (hit) fresh.push(...hit);
      else if (Date.now() - last < MISSING_EVERY_MS) missingSkipped = true;
      else {
        caches.lastMissing.set(throttleKey, Date.now());
        const found = await askJson(ask.missing, missingMessages({ rules: toPromptRules(obligations), text, locale, targetType: input.targetType, title: ctxIn.title }), meta,
          (raw) => parseVerdicts(raw, { paragraphs, fullText: text, ruleIds: oIds, allowMissing: true, refs: obligations.map((r) => `${r.corpusName} ${r.ref}`) }).filter((f) => f.verdict === "missing"));
        cost.muxCalls++;
        caches.missing.set(mKey, found);
        fresh.push(...found);
      }
    } else missingSkipped = !(ctxIn.missing ?? true);
  } catch (e) {
    if (mux.isMuxDown(e) || e instanceof mux.MuxError) unavailable = true;
    else throw e;
  }

  const kept = dropRedundantMissing(fresh);
  fresh.length = 0;
  fresh.push(...kept);

  // Spans of documents point back at their block.
  if (ctxIn.blockOf) for (const f of fresh) if (f.span) (f.span as Span & { block?: string | null }).block = ctxIn.blockOf(f.span.start);

  let findings: FindingView[];
  const ruleById = new Map(rules.map((r) => [r.id, r]));
  if (persist && !unavailable) {
    await store(v, input.targetType, targetId!, ctxIn.version ?? null, fresh, ruleById, { carryMissing: missingSkipped, unchecked });
    findings = await findingsFor(v, input.targetType, targetId!);
  } else if (persist) {
    findings = await findingsFor(v, input.targetType, targetId!);
  } else {
    findings = await viewsOf(v, fresh.map((f, i) => ({ id: `tmp-${i}`, f })), ruleById);
  }
  cost.ms = Date.now() - t0;
  const counts = countOf(findings);
  const status: CheckResult["status"] = unavailable ? "unavailable" : unchecked.length ? "partial" : "done";
  await db.update(complianceRuns).set({
    status: unavailable ? "failed" : "done", paragraphsCached: cost.cached, muxCalls: cost.muxCalls, counts: counts as unknown as Record<string, number>, ms: cost.ms,
    error: unavailable ? "mux unreachable" : null, finishedAt: new Date(),
  }).where(eq(complianceRuns.id, run.id));
  return {
    status, corpora: corpusList, rulesChecked: rules.length, findings, counts, cost, runId: run.id,
    note: unavailable ? "The model gateway (mux) can't be reached, so this wasn't checked just now. The last results are shown." : null,
  };
}

function countOf(list: FindingView[]): Counts {
  return list.length ? countFindings(list.map((f) => ({ status: f.status, verdict: f.verdict, severity: f.rule.severity }))) : { ...EMPTY_COUNTS };
}

/** Write one check's findings next to what was stored for the same target (see `reconcile`). */
async function store(v: Viewer, targetType: string, targetId: string, version: number | null, fresh: FreshFinding[], rules: Map<string, ActiveRule>,
  opts: { carryMissing: boolean; unchecked: Paragraph[] }) {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`compliance:${targetType}:${targetId}`}))`);
    const stored = await tx.select({ id: complianceFindings.id, fingerprint: complianceFindings.fingerprint, status: complianceFindings.status, verdict: complianceFindings.verdict, span: complianceFindings.span, ruleId: complianceFindings.ruleId })
      .from(complianceFindings).where(and(eq(complianceFindings.graphId, v.graphId), eq(complianceFindings.targetType, targetType), eq(complianceFindings.targetId, targetId)));
    const r = reconcile(stored, fresh, { carry: opts.carryMissing ? ["missing"] : [] });
    // Findings in paragraphs this check didn't get to (over the cap) stay as they were.
    const keep = new Set(stored.filter((s) => s.span && opts.unchecked.some((p) => p.text.includes((s.span as Span).text))).map((s) => s.id));
    // Rules no longer checked (retired, or out of scope now) don't make their findings "fixed".
    const live = new Set(rules.keys());
    const fix = r.fix.filter((id) => !keep.has(id) && live.has(stored.find((s) => s.id === id)!.ruleId));
    const now = new Date();
    const values = (f: FreshFinding) => ({ verdict: f.verdict, explanation: f.explanation, suggestion: f.suggestion, span: f.span, targetVersion: version, updatedAt: now });
    const ins = r.insert.filter((f) => rules.has(f.ruleId));
    if (ins.length) {
      await tx.insert(complianceFindings).values(ins.map((f) => ({
        graphId: v.graphId, targetType, targetId, ruleId: f.ruleId, corpusId: rules.get(f.ruleId)!.corpusId, fingerprint: f.fingerprint, status: "open", ...values(f),
      })));
    }
    for (const u of r.update) await tx.update(complianceFindings).set(values(u.finding)).where(eq(complianceFindings.id, u.id));
    for (const u of r.reopen) await tx.update(complianceFindings).set({ ...values(u.finding), status: "open", fixedAt: null }).where(eq(complianceFindings.id, u.id));
    if (fix.length) await tx.update(complianceFindings).set({ status: "fixed", fixedAt: now, updatedAt: now }).where(inArray(complianceFindings.id, fix));
  });
}

async function readable(v: Viewer, ids: (string | null)[]): Promise<Map<string, string>> {
  const list = [...new Set(ids.filter((x): x is string => !!x))];
  if (!list.length) return new Map();
  const rows = await db.select({ id: sources.id, title: sources.title }).from(sources).where(and(inArray(sources.id, list), sourceVisibleTo(v)));
  return new Map(rows.map((r) => [r.id, r.title]));
}

async function viewsOf(v: Viewer, list: { id: string; f: FreshFinding }[], rules: Map<string, ActiveRule>): Promise<FindingView[]> {
  const titles = await readable(v, [...rules.values()].map((r) => r.sourceId));
  return list.filter((x) => rules.has(x.f.ruleId)).map(({ id, f }) => {
    const r = rules.get(f.ruleId)!;
    const open = !!r.sourceId && titles.has(r.sourceId);
    return {
      id, verdict: f.verdict, status: "open", explanation: f.explanation, suggestion: f.suggestion, span: f.span,
      rule: { id: r.id, ref: r.ref, title: r.title, text: r.text, modality: r.modality, severity: r.severity, quote: open ? r.quote : null, sourceId: open ? r.sourceId : null,
        sourceTitle: open ? titles.get(r.sourceId!) ?? null : null, locator: open ? r.locator : {}, corpusId: r.corpusId, corpusName: r.corpusName },
      acceptedReason: null, acceptedByName: null, acceptedAt: null, createdAt: new Date().toISOString(),
    };
  }).sort(bySeverity);
}

const SEV: Record<string, number> = { blocker: 0, major: 1, minor: 2, info: 3 };
const bySeverity = (a: FindingView, b: FindingView) => (a.status === "accepted" ? 1 : 0) - (b.status === "accepted" ? 1 : 0)
  || (SEV[a.rule.severity] ?? 9) - (SEV[b.rule.severity] ?? 9) || (a.span?.start ?? 1e9) - (b.span?.start ?? 1e9);

/** The findings that matter now for a target: open ones and accepted deviations (fixed ones are history). */
export async function findingsFor(v: Viewer, targetType: string, targetId: string): Promise<FindingView[]> {
  const rows = await db.select({
    id: complianceFindings.id, verdict: complianceFindings.verdict, status: complianceFindings.status, explanation: complianceFindings.explanation,
    suggestion: complianceFindings.suggestion, span: complianceFindings.span, acceptedReason: complianceFindings.acceptedReason, acceptedAt: complianceFindings.acceptedAt,
    acceptedByName: users.name, createdAt: complianceFindings.createdAt,
    ruleId: corpusRules.id, ref: corpusRules.ref, title: corpusRules.title, text: corpusRules.text, modality: corpusRules.modality, severity: corpusRules.severity,
    quote: corpusRules.quote, sourceId: corpusRules.sourceId, locator: corpusRules.locator, corpusId: corpora.id, corpusName: corpora.name, ruleStatus: corpusRules.status,
  }).from(complianceFindings)
    .innerJoin(corpusRules, eq(corpusRules.id, complianceFindings.ruleId))
    .innerJoin(corpora, eq(corpora.id, complianceFindings.corpusId))
    .leftJoin(users, eq(users.id, complianceFindings.acceptedBy))
    .where(and(eq(complianceFindings.graphId, v.graphId), eq(corpora.graphId, v.graphId), eq(complianceFindings.targetType, targetType), eq(complianceFindings.targetId, targetId),
      inArray(complianceFindings.status, ["open", "accepted"])))
    .orderBy(desc(complianceFindings.createdAt)).limit(200);
  const titles = await readable(v, rows.map((r) => r.sourceId));
  return rows.filter((r) => r.ruleStatus === "active").map((r) => {
    const open = !!r.sourceId && titles.has(r.sourceId);
    return {
      id: r.id, verdict: r.verdict, status: r.status, explanation: r.explanation, suggestion: r.suggestion, span: r.span ?? null,
      rule: { id: r.ruleId, ref: r.ref, title: r.title, text: r.text, modality: r.modality, severity: r.severity, quote: open ? r.quote : null, sourceId: open ? r.sourceId : null,
        sourceTitle: open ? titles.get(r.sourceId!) ?? null : null, locator: open ? (r.locator as Record<string, unknown>) : {}, corpusId: r.corpusId, corpusName: r.corpusName },
      acceptedReason: r.acceptedReason, acceptedByName: r.acceptedByName ?? null, acceptedAt: r.acceptedAt?.toISOString() ?? null, createdAt: r.createdAt.toISOString(),
    };
  }).sort(bySeverity);
}

/** The last check of a target (for "Checked against 2 corpora" and "checking …"). */
export async function lastRun(v: Viewer, targetType: string, targetId: string) {
  const [r] = await db.select().from(complianceRuns)
    .where(and(eq(complianceRuns.graphId, v.graphId), eq(complianceRuns.targetType, targetType), eq(complianceRuns.targetId, targetId)))
    .orderBy(desc(complianceRuns.createdAt)).limit(1);
  if (!r) return null;
  const names = r.corpusIds.length ? await db.select({ id: corpora.id, name: corpora.name }).from(corpora).where(and(inArray(corpora.id, r.corpusIds), eq(corpora.graphId, v.graphId))) : [];
  return { id: r.id, status: r.status, corpora: names, rulesChecked: r.rulesChecked, muxCalls: r.muxCalls, paragraphs: r.paragraphs, paragraphsCached: r.paragraphsCached, ms: r.ms, at: r.createdAt.toISOString(), finishedAt: r.finishedAt?.toISOString() ?? null };
}

/* ── Deciding findings ──────────────────────────────────────────────────────────────────────────────────── */

async function ownFinding(v: Viewer, id: string) {
  const [f] = await db.select({ f: complianceFindings, rule: corpusRules, corpus: corpora }).from(complianceFindings)
    .innerJoin(corpusRules, eq(corpusRules.id, complianceFindings.ruleId)).innerJoin(corpora, eq(corpora.id, complianceFindings.corpusId))
    .where(and(eq(complianceFindings.id, id), eq(complianceFindings.graphId, v.graphId))).limit(1);
  if (!f) throw new ComplianceError(404, "That note isn't here any more.");
  return f;
}

/**
 * Keep a deviation on purpose. The reason is required, stored on the finding, and recorded in the graph's history
 * (on the corpus, and on the wiki page when it is one) and in the activity log.
 */
export async function acceptFinding(v: Viewer, id: string, reason: string): Promise<void> {
  const problem = acceptProblem(reason);
  if (problem) throw new ComplianceError(400, problem);
  const { f, rule, corpus } = await ownFinding(v, id);
  if (f.status === "accepted") return;
  const now = new Date();
  await db.update(complianceFindings).set({ status: "accepted", acceptedReason: reason.trim(), acceptedBy: v.id, acceptedAt: now, updatedAt: now }).where(eq(complianceFindings.id, id));
  const stamp = stampFor({ actor: { kind: "person", id: v.id, name: v.name }, context: "compliance" });
  const event = { ref: rule.ref, corpus: corpus.name, target: `${f.targetType}:${f.targetId}`, reason: reason.trim(), passage: f.span?.text ?? null };
  if (corpus.nodeId) await recordEvent(db, v.graphId, { subjectType: "node", subjectId: corpus.nodeId, subjectName: corpus.name, kind: "updated", field: "compliance.deviation", fromValue: null, toValue: event }, stamp);
  if (f.targetType === "wiki") await recordEvent(db, v.graphId, { subjectType: "wiki", subjectId: f.targetId, subjectName: null, kind: "updated", field: "compliance.deviation", fromValue: null, toValue: event }, stamp);
  void logActivity({
    graphId: v.graphId, userId: v.id, actor: f.targetType === "message" ? "chat" : "wiki", action: "accepted_deviation",
    summary: `Kept a deviation from ${corpus.name} ${rule.ref}: ${reason.trim().slice(0, 200)}`, subjectType: f.targetType, subjectId: f.targetId, visibility: "household",
  });
}

/** Accept every open finding of a target at once (Publish anyway). Returns how many were accepted. */
export async function acceptAll(v: Viewer, targetType: string, targetId: string, reason: string, opts: { severities?: string[] } = {}): Promise<number> {
  const problem = acceptProblem(reason);
  if (problem) throw new ComplianceError(400, problem);
  const open = (await findingsFor(v, targetType, targetId)).filter((f) => f.status === "open" && (!opts.severities || opts.severities.includes(f.rule.severity)));
  for (const f of open) await acceptFinding(v, f.id, reason);
  return open.length;
}

/** Mark a finding fixed (a suggested fix was applied) or open again. */
export async function setFindingStatus(v: Viewer, id: string, status: "fixed" | "open"): Promise<void> {
  const { f } = await ownFinding(v, id);
  const now = new Date();
  await db.update(complianceFindings).set({ status, fixedAt: status === "fixed" ? now : null, acceptedReason: status === "open" ? null : f.acceptedReason, updatedAt: now })
    .where(eq(complianceFindings.id, id));
}

/** Which target a finding belongs to (for access checks in routes). */
export async function findingTarget(v: Viewer, id: string): Promise<{ targetType: string; targetId: string }> {
  const { f } = await ownFinding(v, id);
  return { targetType: f.targetType, targetId: f.targetId };
}

/* ── "Check against" ────────────────────────────────────────────────────────────────────────────────────── */

/** A page's own choice of corpora (null = use the graph's default). targetType "graph" sets the default. */
export async function setChoice(v: Viewer, targetType: string, targetId: string, corpusIds: string[] | null): Promise<void> {
  const tid = targetType === "graph" ? "" : targetId;
  if (corpusIds === null) {
    await db.delete(complianceTargets).where(and(eq(complianceTargets.graphId, v.graphId), eq(complianceTargets.targetType, targetType), eq(complianceTargets.targetId, tid)));
    return;
  }
  const valid = corpusIds.length ? (await db.select({ id: corpora.id }).from(corpora).where(and(eq(corpora.graphId, v.graphId), inArray(corpora.id, corpusIds)))).map((r) => r.id) : [];
  await db.insert(complianceTargets).values({ graphId: v.graphId, targetType, targetId: tid, corpusIds: valid, updatedBy: v.id })
    .onConflictDoUpdate({ target: [complianceTargets.graphId, complianceTargets.targetType, complianceTargets.targetId], set: { corpusIds: valid, updatedBy: v.id, updatedAt: new Date() } });
}

export async function getChoice(v: Viewer, ctx: CheckContext, targetId: string | null) {
  const { picked, all, choice } = await corporaFor(v, ctx, targetId);
  return {
    own: choice.page, graphDefault: choice.graph,
    effective: picked.map((c) => c.id),
    corpora: all.filter((c) => c.status !== "retired").map((c) => ({ id: c.id, name: c.name, status: c.status, kind: c.kind, binding: c.binding, checkByDefault: c.checkByDefault })),
  };
}
