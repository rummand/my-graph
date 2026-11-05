/**
 * "Add from a link" and the work behind it (server-only). A person pastes one address; the rule set is created at
 * once (a draft, named from a first look at the page) and a durable job (src/lib/jobs, kind "corpus.work") does the
 * rest, resuming where it was after a restart:
 *
 *   crawl       the page, its parts or one-page view, its official PDF, what it links to one level out (./crawl)
 *   pass 1      structure: every unit of the text (§, stk., nr., litra / article, paragraph, point …), the coverage
 *               map, the units that hold no rule by nature, the terms defined, cross-references, the PDF page of each
 *   pass 2      extraction: rules per passage of whole units, each with its exact quote (checked word for word)
 *   pass 3      completeness: every unit without a rule, every deadline/penalty/definition without one, and every
 *               rule read with low confidence is read again; what truly holds no rule is noted with why
 *   pass 4      understanding: duplicates across documents merged, guidance attached as interpretation, a summary
 *               per chapter and of the whole set, open questions, and the completeness report
 *
 * Everything read is proposed: rules and definitions wait for a person (src/lib/corpus/index.ts decideRules). Legal
 * text is data, never instructions. Without mux, the crawl and the deterministic parts still run (pass 1, the
 * definitions it can see, the report); the model passes say why they were skipped.
 */
import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { chunks, corpora, corpusRules, corpusSources, corpusUnits, jobs, sources } from "@/db/schema";
import type { Viewer } from "@/lib/auth";
import { viewerFor } from "@/lib/auth/viewer-for";
import { scopeOf } from "@/lib/graphs/pure";
import * as mux from "@/lib/mux";
import { localeOf } from "@/lib/assistant/locale";
import { logActivity } from "@/lib/automations";
import { enqueueJob } from "@/lib/jobs/queue";
import { PermanentJobError, type JobProgress } from "@/lib/jobs/policy";
import type { JobRow } from "@/lib/jobs/queue";
import { checkPublicUrl } from "@/lib/web/guard";
import { clip, overlap } from "@/lib/compliance/text";
import { canManageCorpora, CorpusError, createCorpus } from "./index";
import { dedupeRules, defaultSeverity, diffVersion, sectionOf, type Binding, type Modality, type RuleSetKind, type Severity, type SourceRole } from "./pure";
import { classificationMessages, classifyUrl, describe, parseClassification, type Description } from "./crawl/classify";
import { crawl, type CrawlDoc, type Skipped } from "./crawl/engine";
import { guardedGet, robotsAllow } from "./crawl/fetch";
import { htmlTitle, htmlToText } from "./crawl/html";
import { DEFAULT_LIMITS } from "./crawl/links";
import { lexDaniaMeta, popularName, retsinfoUrls, type Related } from "./crawl/retsinformation";
import { celexShortName } from "./crawl/eurlex";
import { demote, storeDoc } from "./crawl/store";
import { detectFamily, parseUnits, PROVISION_KINDS, TOP_KINDS, type Family, type Unit } from "./read/units";
import { accountFor, coverageOf, definitionsIn, diffUnits, interpretationLinks, LOW_CONFIDENCE, noRuleCode, pageOf, passagesFor, rereadList, type CompletenessReport } from "./read/analysis";
import { extractMessages, jsonOf, parseReading, parseUnderstanding, rereadMessages, understandMessages, type ReadAnswer, type SetInfo, type Understanding } from "./read/prompts";

/* ── The state the rule set page shows ───────────────────────────────────────────────────────────────────── */

type PassStatus = "waiting" | "running" | "done" | "skipped" | "failed";

export type WorkState = {
  status: "queued" | "running" | "done" | "failed";
  mode: "full" | "recheck";
  stage: "crawl" | "structure" | "extract" | "complete" | "understand" | "done";
  startedAt: string; finishedAt: string | null; error: string | null;
  /** Why the model passes were skipped or cut short ("mux can't be reached"). */
  degraded: string | null;
  /** The name and kind came from the page (not typed by a person): the crawl may refine them. */
  autoNamed: boolean;
  crawl: {
    status: PassStatus; fetched: number; pages: number; pdfs: number; current: string | null;
    docs: { url: string; title: string; role: SourceRole; format: string; reference: boolean; amendment: boolean; reason: string; status: string; sourceId: string; pages: number | null }[];
    skipped: Skipped[]; related: { url: string; title: string; shortName: string; relation: string }[];
  };
  passes: {
    1: { status: PassStatus; sources: number; units: number; definitions: number; refs: number; accounted: number };
    2: { status: PassStatus; done: number; total: number; rules: number; definitions: number; dropped: number };
    3: { status: PassStatus; done: number; total: number; rules: number; definitions: number; noRule: number; dropped: number };
    4: { status: PassStatus; done: number; total: number; merged: number; interpretations: number; summaries: number };
  };
  model: { calls: number; failures: number; ms: number; promptChars: number; answerChars: number; byPass: Record<string, number>; models: Record<string, number> };
  /** "Check for changes": what moved since the last reading. */
  changes: { sources: { new: number; changed: number; unchanged: number }; units: { added: number; changed: number; removed: number }; proposed: { added: number; changed: number; removed: number } } | null;
};

export type UnderstandingState = Understanding & { report: CompletenessReport | null; at: string | null };

const now = () => new Date().toISOString();

export function freshWork(mode: WorkState["mode"], autoNamed: boolean): WorkState {
  return {
    status: "queued", mode, stage: "crawl", startedAt: now(), finishedAt: null, error: null, degraded: null, autoNamed,
    crawl: { status: "waiting", fetched: 0, pages: 0, pdfs: 0, current: null, docs: [], skipped: [], related: [] },
    passes: {
      1: { status: "waiting", sources: 0, units: 0, definitions: 0, refs: 0, accounted: 0 },
      2: { status: "waiting", done: 0, total: 0, rules: 0, definitions: 0, dropped: 0 },
      3: { status: "waiting", done: 0, total: 0, rules: 0, definitions: 0, noRule: 0, dropped: 0 },
      4: { status: "waiting", done: 0, total: 0, merged: 0, interpretations: 0, summaries: 0 },
    },
    model: { calls: 0, failures: 0, ms: 0, promptChars: 0, answerChars: 0, byPass: {}, models: {} },
    changes: null,
  };
}

async function saveWork(id: string, w: WorkState): Promise<void> {
  await db.update(corpora).set({ work: w as unknown as Record<string, unknown>, updatedAt: new Date() }).where(eq(corpora.id, id));
}

/* ── Add from a link ─────────────────────────────────────────────────────────────────────────────────────── */

const LIVE_STALE_MS = 6 * 3600_000;

/** A first look at the pasted page (a few seconds at most): name, kind, authority, version. Null when it can't look. */
async function firstLook(v: Viewer, url: string): Promise<Description | null> {
  const site = classifyUrl(url);
  try {
    if (site.site === "retsinformation") {
      const f = await guardedGet(retsinfoUrls(site.eli).xml, { accept: "application/xml", maxBytes: 20 * 1024 * 1024 });
      const xml = new TextDecoder().decode(f.body);
      const m = lexDaniaMeta(xml);
      return describe({ url, site, title: m.title ?? "", text: xml.slice(0, 4000), meta: { docType: m.docType, shortName: m.shortName, popular: popularName(m.title), ministry: m.ministry, startDate: m.startDate } });
    }
    if (site.site === "eurlex") {
      return { name: celexShortName(site.celex, site.lang), kind: "law", authority: site.lang === "da" ? "Den Europæiske Union" : "European Union", version: celexShortName(site.celex, site.lang), effectiveFrom: null, binding: "mandatory", family: "eu", sure: true };
    }
    if (site.site === "pdf") return describe({ url, site, title: decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "").replace(/\.pdf$/i, "").replace(/[-_]+/g, " "), text: "" });
    const f = await guardedGet(url, { accept: "text/html,application/xhtml+xml", maxBytes: 4 * 1024 * 1024 });
    if (/application\/pdf/i.test(f.type)) return describe({ url, site: { site: "pdf" }, title: decodeURIComponent(new URL(f.url).pathname.split("/").pop() ?? "").replace(/\.pdf$/i, ""), text: "" });
    const html = new TextDecoder().decode(f.body);
    const title = htmlTitle(html);
    const text = htmlToText(html);
    const d = describe({ url: f.url, site, title, text });
    if (d.sure) return d;
    // The words don't say: ask the model (route fast), with the page as fenced data.
    if (!(await mux.muxHealth().then((h) => h.ok).catch(() => false))) return d;
    try {
      const r = await mux.complete({ route: "fast", json: true, maxTokens: 300, temperature: 0, messages: classificationMessages({ url, title, text }), meta: { userId: v.id, agent: "my-graph:rule-classifier", graphId: v.graphId } });
      return parseClassification(jsonOf(r.text), d);
    } catch {
      return d;
    }
  } catch {
    return null;
  }
}

/** A name from the address alone, while the first look is out of reach. */
function nameFromUrl(url: string): string {
  const site = classifyUrl(url);
  if (site.site === "retsinformation") return `Retsinformation ${site.eli.replace(/^\/eli\/[a-z]+\//, "").replace(/\//g, "/")}`;
  if (site.site === "eurlex") return celexShortName(site.celex, site.lang);
  try {
    const u = new URL(url);
    const last = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() ?? "").replace(/\.(pdf|html?)$/i, "").replace(/[-_]+/g, " ").trim();
    return last ? `${last[0].toUpperCase()}${last.slice(1)} (${u.hostname.replace(/^www\./, "")})` : u.hostname.replace(/^www\./, "");
  } catch { return "Rule set"; }
}

export type FromLinkResult = { id: string; name: string; kind: RuleSetKind; jobId: string };

/** Paste a link: the rule set exists at once (a draft), and the crawl and the four readings start in the background. */
export async function addFromLink(v: Viewer, rawUrl: string): Promise<FromLinkResult> {
  if (!canManageCorpora(v)) throw new CorpusError(403, "Only people who may change this graph can add rule sets.");
  const url = rawUrl.trim().replace(/^<|>$/g, "");
  const g = await checkPublicUrl(/^https?:\/\//i.test(url) ? url : `https://${url}`);
  if (!g.ok) throw new CorpusError(400, g.reason === "unresolved" ? "That address could not be found." : "Only pages on the public web can be read.");
  const look = await Promise.race([firstLook(v, g.url), new Promise<null>((r) => setTimeout(() => r(null), 15_000))]);
  const name = look?.name ?? nameFromUrl(g.url);
  const kind = look?.kind ?? "own_rules";
  const c = await createCorpus(v, {
    name: clip(name, 160), kind, authority: look?.authority ?? null, binding: look?.binding ?? "mandatory", version: look?.version ?? null,
    effectiveFrom: look?.effectiveFrom ?? null, description: null, status: "draft",
  });
  const work = freshWork("full", true);
  await db.update(corpora).set({ startUrl: g.url, work: work as unknown as Record<string, unknown> }).where(eq(corpora.id, c.id));
  const job = await enqueueJob({ graphId: v.graphId, userId: v.id, kind: "corpus.work", subjectId: null, payload: { corpusId: c.id, mode: "full" }, priority: 5, maxAttempts: 3 });
  void logActivity({ graphId: v.graphId, userId: v.id, actor: "wiki", action: "created_corpus", summary: `Started the rule set "${name}" from ${new URL(g.url).hostname}`, subjectType: "corpus", subjectId: c.id, visibility: "household" });
  return { id: c.id, name, kind, jobId: job.id };
}

/** Is a job for this rule set waiting or running? */
async function liveJob(corpusId: string): Promise<{ id: string; status: string } | null> {
  const [j] = await db.select({ id: jobs.id, status: jobs.status, updatedAt: jobs.updatedAt }).from(jobs)
    .where(and(eq(jobs.kind, "corpus.work"), inArray(jobs.status, ["queued", "running"]), sql`${jobs.payload}->>'corpusId' = ${corpusId}`)).limit(1);
  if (!j || Date.now() - j.updatedAt.getTime() > LIVE_STALE_MS) return null;
  return j;
}

/**
 * "Check for changes" (mode recheck): read the same pages again; unchanged pages do nothing, changed ones become new
 * versions and only their changed units are read again, as a proposal of added, changed and removed rules.
 * "Read again" (mode full) re-runs the readings on what the rule set has (and fetches its link again).
 */
export async function startWork(v: Viewer, corpusId: string, mode: "full" | "recheck"): Promise<{ jobId: string }> {
  if (!canManageCorpora(v)) throw new CorpusError(403, "Only people who may change this graph can do that.");
  const [c] = await db.select().from(corpora).where(and(eq(corpora.id, corpusId), eq(corpora.graphId, v.graphId))).limit(1);
  if (!c) throw new CorpusError(404, "That rule set isn't here.");
  if (!c.startUrl) throw new CorpusError(400, "This rule set wasn't started from a link, so there is nothing to read again from the web.");
  if (await liveJob(corpusId)) throw new CorpusError(409, "This rule set is being read already.");
  const prev = c.work as WorkState | null;
  await saveWork(corpusId, { ...freshWork(mode, prev?.autoNamed ?? false) });
  const job = await enqueueJob({ graphId: v.graphId, userId: v.id, kind: "corpus.work", subjectId: null, payload: { corpusId, mode }, priority: 5, maxAttempts: 3 });
  return { jobId: job.id };
}

/* ── The job ─────────────────────────────────────────────────────────────────────────────────────────────── */

type Ctx = { progress: (p: JobProgress) => Promise<void> };
type CorpusRow = typeof corpora.$inferSelect;

/** At most this many model calls per run (passes 2–4 together), so one huge act can't take the gateway for hours. */
const MODEL_BUDGET = Number(process.env.RULES_MODEL_BUDGET ?? 220);
/** Reading passes read at most this many characters of supporting documents (executive orders under the act). */
const SUPPORTING_CHARS = 60_000;

export async function corpusWorkJob(job: JobRow, ctx: Ctx): Promise<void> {
  const corpusId = String(job.payload.corpusId ?? "");
  const v = await viewerFor(job.userId, job.graphId);
  if (!v) throw new PermanentJobError("The person who started it is no longer a member of this graph.");
  if (!scopeOf(v).canWrite) throw new PermanentJobError("The person who started it can no longer change this graph.");
  const load = async () => {
    const [c] = await db.select().from(corpora).where(and(eq(corpora.id, corpusId), eq(corpora.graphId, job.graphId))).limit(1);
    if (!c) throw new PermanentJobError("The rule set was deleted.");
    return c;
  };
  let c = await load();
  const mode = job.payload.mode === "recheck" ? "recheck" : "full";
  const w: WorkState = { ...freshWork(mode, true), ...((c.work as WorkState | null) ?? {}) };
  w.status = "running";
  w.error = null;
  const save = () => saveWork(corpusId, w);
  const step = async (label: string, done?: number, total?: number) => { await ctx.progress({ step: w.stage, label, done, total }); };
  const run = new Runner(v, c, w, save);
  try {
    if (w.stage === "crawl") {
      await step("Reading the pages");
      await run.crawl(mode);
      w.stage = "structure"; await save();
      c = await load(); run.c = c;
    }
    if (w.stage === "structure") { await step("Pass 1: structure"); await run.structure(mode); w.stage = "extract"; await save(); }
    if (w.stage === "extract") { await run.extract(mode, (d, t) => step("Pass 2: rules", d, t)); w.stage = "complete"; await save(); }
    if (w.stage === "complete") { await run.complete(mode, (d, t) => step("Pass 3: completeness", d, t)); w.stage = "understand"; await save(); }
    if (w.stage === "understand") { await run.understand((d, t) => step("Pass 4: understanding", d, t)); w.stage = "done"; }
    w.status = "done";
    w.finishedAt = now();
    await save();
    const found = w.passes[2].rules + w.passes[3].rules;
    void logActivity({ graphId: v.graphId, userId: v.id, actor: "ingest", action: "proposed_rules", summary: `Read "${c.name}": ${found} ${found === 1 ? "rule" : "rules"} and ${w.passes[2].definitions + w.passes[3].definitions + w.passes[1].definitions} definitions to review`, subjectType: "corpus", subjectId: corpusId, visibility: "household" });
  } catch (e) {
    if ((e as { name?: string }).name === "Released" || /server is restarting/i.test(String((e as Error).message))) throw e;
    w.error = e instanceof Error ? e.message.slice(0, 400) : "Reading failed.";
    const last = job.attempts >= job.maxAttempts || e instanceof PermanentJobError;
    w.status = last ? "failed" : "running";
    if (last) w.finishedAt = now();
    await save().catch(() => {});
    throw e;
  }
}

/* ── The passes ──────────────────────────────────────────────────────────────────────────────────────────── */

type SrcRow = { sourceId: string; role: string; title: string; text: string; url: string | null; meta: Record<string, unknown> };

class Runner {
  private muxUp: boolean | null = null;
  /** Passes that used up their share of the model budget in this run. */
  stopped = new Set<number>();
  private locale: "en" | "da" = "en";
  constructor(private v: Viewer, public c: CorpusRow, private w: WorkState, private save: () => Promise<void>) {}

  private set(): SetInfo { return { name: this.c.name, kind: this.c.kind, authority: this.c.authority, binding: this.c.binding as Binding }; }

  /* crawl */
  async crawl(mode: "full" | "recheck"): Promise<void> {
    const v = this.v, w = this.w;
    w.crawl = { status: "running", fetched: 0, pages: 0, pdfs: 0, current: null, docs: [], skipped: [], related: [] };
    w.changes = mode === "recheck" ? { sources: { new: 0, changed: 0, unchanged: 0 }, units: { added: 0, changed: 0, removed: 0 }, proposed: { added: 0, changed: 0, removed: 0 } } : null;
    await this.save();
    let lastSave = 0;
    const muxUp = await this.mux();
    const result = await crawl(this.c.startUrl!, {
      fetch: (url, opts) => guardedGet(url, opts),
      robotsAllow,
      readText: muxUp ? async (url) => {
        const g = await checkPublicUrl(url);
        if (!g.ok) return null;
        const p = await mux.read({ url: g.url, maxChars: 100_000, meta: { userId: v.id, agent: "my-graph:rule-crawler", graphId: v.graphId } });
        return { title: p.title, text: p.text };
      } : undefined,
      onDoc: async (doc: CrawlDoc) => {
        const s = await storeDoc(v, this.c.id, doc);
        w.crawl.docs.push({ url: doc.url, title: doc.title, role: doc.role, format: doc.format, reference: doc.reference, amendment: !!doc.amendment, reason: doc.reason, status: s.status, sourceId: s.sourceId, pages: s.pages });
        if (w.changes) w.changes.sources[s.status]++;
        await this.save();
      },
      onDemote: async (url, role) => {
        await demote(v, this.c.id, url, role);
        for (const d of w.crawl.docs) if (d.url === url) d.role = role;
      },
      onProgress: async (p) => {
        Object.assign(w.crawl, { fetched: p.fetched, pages: p.pages, pdfs: p.pdfs, current: p.current });
        if (Date.now() - lastSave > 1500) { lastSave = Date.now(); await this.save(); }
      },
    }, DEFAULT_LIMITS);
    w.crawl.status = result.docs ? "done" : "failed";
    w.crawl.current = null;
    w.crawl.skipped = result.skipped.slice(0, 40);
    w.crawl.related = result.related.slice(0, 30).map((r: Related) => ({ url: r.url, title: r.title, shortName: r.shortName, relation: r.relation }));
    await this.save();
    if (!result.docs) throw new PermanentJobError(result.skipped[0]?.detail ? `The page couldn't be read: ${result.skipped[0].detail}` : "The page couldn't be read.");
    // A better name, kind and version from what was read (only while the name is still the one we proposed).
    const d = result.description;
    if (d && w.autoNamed && mode === "full") {
      await db.update(corpora).set({
        name: clip(d.name, 160), kind: d.kind, authority: d.authority ?? this.c.authority, version: d.version ?? this.c.version, binding: d.binding,
        effectiveFrom: d.effectiveFrom ? new Date(d.effectiveFrom) : this.c.effectiveFrom, startUrl: this.c.startUrl, updatedAt: new Date(),
      }).where(eq(corpora.id, this.c.id));
    }
  }

  private async mux(): Promise<boolean> {
    if (this.muxUp === null) {
      this.muxUp = await mux.muxHealth({ fresh: true }).then((h) => h.ok).catch(() => false);
      this.locale = (await localeOf(this.v.id)) as "en" | "da";
      if (!this.muxUp) this.w.degraded = "The model gateway (mux) can't be reached: the pages were read and their structure mapped, but the rules can't be read until it is back. Press Read again then.";
    }
    return this.muxUp;
  }

  /** The documents read in the passes: the text (not the reference PDF, not amendments), then supporting acts. */
  private async readingSources(): Promise<SrcRow[]> {
    const rows = await db.select({ sourceId: corpusSources.sourceId, role: corpusSources.role, title: sources.title, text: sources.textContent, url: sources.url, meta: sources.meta, mime: sources.mime })
      .from(corpusSources).innerJoin(sources, eq(sources.id, corpusSources.sourceId))
      .where(and(eq(corpusSources.corpusId, this.c.id), eq(corpusSources.graphId, this.v.graphId))).orderBy(asc(corpusSources.createdAt));
    const crawlOf = (m: Record<string, unknown>) => (m?.crawl ?? {}) as Record<string, unknown>;
    const out = rows.filter((r) => r.text?.trim() && !crawlOf(r.meta).reference && !crawlOf(r.meta).amendment && r.role !== "interpretation")
      .map((r) => ({ sourceId: r.sourceId, role: r.role, title: r.title, text: r.text!, url: r.url, meta: r.meta }));
    return [...out.filter((r) => r.role === "text"), ...out.filter((r) => r.role !== "text")];
  }

  /** The official PDF's pages for a text source (the reference of record), when the crawl found it. */
  private refPages = new Map<string, { sourceId: string; pages: string[] } | null>();
  private async referencePages(src: SrcRow): Promise<{ sourceId: string; pages: string[] } | null> {
    if (this.refPages.has(src.sourceId)) return this.refPages.get(src.sourceId)!;
    const found = await this.findReference(src);
    this.refPages.set(src.sourceId, found);
    return found;
  }
  private async findReference(src: SrcRow): Promise<{ sourceId: string; pages: string[] } | null> {
    const rows = await db.select({ id: sources.id, text: sources.textContent, meta: sources.meta }).from(corpusSources).innerJoin(sources, eq(sources.id, corpusSources.sourceId))
      .where(and(eq(corpusSources.corpusId, this.c.id), sql`${sources.meta}->'crawl'->>'reference' = 'true'`, sql`${sources.meta}->'crawl'->>'referenceOf' = ${src.url ?? ""}`)).limit(1);
    const r = rows[0];
    return r?.text ? { sourceId: r.id, pages: r.text.split("\f").map((p) => p.trim()) } : null;
  }

  /* pass 1 */
  async structure(_mode: "full" | "recheck"): Promise<void> {
    const w = this.w;
    w.passes[1].status = "running";
    await this.save();
    const srcs = await this.readingSources();
    const linked = new Set(srcs.map((s) => s.sourceId));
    // Units of documents no longer in the rule set go (their rules stay, citing the version they came from).
    const old = await db.select({ id: corpusUnits.id, sourceId: corpusUnits.sourceId, key: corpusUnits.key, hash: corpusUnits.hash, top: corpusUnits.parentKey, status: corpusUnits.status, note: corpusUnits.note, readAt: corpusUnits.readAt, rereadAt: corpusUnits.rereadAt, refs: corpusUnits.refs })
      .from(corpusUnits).where(eq(corpusUnits.corpusId, this.c.id));
    const have = new Set(old.map((u) => u.sourceId));
    let units = 0, defs = 0, refs = 0, accounted = 0;
    for (const s of srcs) {
      // Already mapped (a changed page is a new source): its units keep what was read, so "Read again" continues.
      if (have.has(s.sourceId)) {
        const mine = old.filter((u) => u.sourceId === s.sourceId);
        units += mine.length;
        refs += mine.reduce((a, u) => a + ((u.refs as unknown[]) ?? []).length, 0);
        accounted += mine.filter((u) => u.status === "heading" || (u.status === "no_rule" && u.note)).length;
        continue;
      }
      const family = detectFamily(s.text);
      const list = parseUnits(s.text, family);
      const ref = await this.referencePages(s);
      // A changed document: which units moved since the version read before (same address, earlier source).
      const prevId = w.crawl.docs.find((d) => d.sourceId === s.sourceId && d.status === "changed") ? await this.previousVersion(s.sourceId) : null;
      const before = prevId ? old.filter((u) => u.sourceId === prevId) : [];
      const diff = prevId ? diffUnits(before.map((u) => ({ key: u.key, hash: u.hash })), list.map((u) => ({ key: u.key, hash: u.hash, top: u.top }))) : null;
      const unchanged = new Set(diff?.unchanged.map((u) => u.key) ?? []);
      await db.delete(corpusUnits).where(and(eq(corpusUnits.corpusId, this.c.id), eq(corpusUnits.sourceId, s.sourceId)));
      const rows = list.map((u) => {
        const note = accountFor(u);
        const was = before.find((b) => b.key === u.key);
        if (note) accounted++;
        refs += u.refs.length;
        return {
          corpusId: this.c.id, graphId: this.v.graphId, sourceId: s.sourceId, key: u.key, kind: u.kind, parentKey: u.parentKey, chapter: u.chapter, idx: u.idx,
          charStart: u.start, charEnd: u.end, page: ref ? pageOf(ref.pages, u.own) : null, hash: u.hash, status: note ? (note === "heading" ? "heading" : "no_rule") : "open",
          note: note ?? (unchanged.has(u.key) ? was?.note ?? null : null), flags: u.flags, refs: u.refs as unknown as Record<string, unknown>[],
          readAt: unchanged.has(u.key) ? was?.readAt ?? new Date() : null, rereadAt: unchanged.has(u.key) ? was?.rereadAt ?? new Date() : null,
        };
      });
      for (let i = 0; i < rows.length; i += 300) await db.insert(corpusUnits).values(rows.slice(i, i + 300)).onConflictDoNothing();
      units += rows.length;
      if (diff && w.changes) {
        w.changes.units.added += diff.added.length; w.changes.units.changed += diff.changed.length; w.changes.units.removed += diff.removed.length;
        await this.proposeRemoved(diff.removed.map((u) => u.key), prevId!);
      }
      // Terms the text defines, read without a model (pass 3 finds the rest).
      defs += await this.insertDefinitions(s, list, definitionsIn(list), 1);
    }
    for (const sid of have) if (!linked.has(sid)) await db.delete(corpusUnits).where(and(eq(corpusUnits.corpusId, this.c.id), eq(corpusUnits.sourceId, sid)));
    w.passes[1] = { status: "done", sources: srcs.length, units: units || w.passes[1].units, definitions: defs, refs, accounted };
    await this.save();
  }

  private async previousVersion(sourceId: string): Promise<string | null> {
    const [s] = await db.select({ lineageId: sources.lineageId, revision: sources.revision }).from(sources).where(eq(sources.id, sourceId)).limit(1);
    if (!s?.lineageId) return null;
    const [p] = await db.select({ id: sources.id }).from(sources).where(and(eq(sources.graphId, this.v.graphId), sql`coalesce(${sources.lineageId}, ${sources.id}) = ${s.lineageId}`, eq(sources.revision, s.revision - 1))).limit(1);
    return p?.id ?? null;
  }

  /** Units gone from the new version: their rules in force are proposed for removal (they stay until approved). */
  private async proposeRemoved(keys: string[], prevSourceId: string): Promise<void> {
    if (!keys.length) return;
    const gone = await db.select().from(corpusRules).where(and(eq(corpusRules.corpusId, this.c.id), eq(corpusRules.status, "active"), eq(corpusRules.sourceId, prevSourceId), inArray(corpusRules.unitKey, keys)));
    for (const r of gone) {
      await db.insert(corpusRules).values({
        corpusId: this.c.id, graphId: this.v.graphId, ref: r.ref, section: r.section, title: r.title, text: r.text, modality: r.modality, appliesTo: r.appliesTo, checkHint: r.checkHint,
        severity: r.severity, sourceId: r.sourceId, chunkId: r.chunkId, locator: r.locator, quote: r.quote, status: "proposed", change: "removed", supersedesId: r.id, corpusVersion: this.c.version,
        kind: r.kind, unitKey: r.unitKey, chapter: r.chapter, confidence: r.confidence, pass: 2,
      });
      if (this.w.changes) this.w.changes.proposed.removed++;
    }
  }

  /** Chunk lookup for a source, to cite the passage a quote is in. */
  private chunkCache = new Map<string, { id: string; start: number; end: number }[]>();
  private async chunkAt(sourceId: string, pos: number): Promise<string | null> {
    let list = this.chunkCache.get(sourceId);
    if (!list) {
      const rows = await db.select({ id: chunks.id, locator: chunks.locator }).from(chunks).where(and(eq(chunks.sourceId, sourceId), eq(chunks.graphId, this.v.graphId))).orderBy(asc(chunks.idx));
      list = rows.map((r) => ({ id: r.id, start: Number((r.locator as Record<string, unknown>).charStart ?? -1), end: Number((r.locator as Record<string, unknown>).charEnd ?? -1) }));
      this.chunkCache.set(sourceId, list);
    }
    return list.find((x) => pos >= x.start && pos < x.end)?.id ?? null;
  }

  private unitsOf = new Map<string, Awaited<ReturnType<Runner["loadUnits"]>>>();
  private async loadUnits(sourceId: string) {
    return db.select().from(corpusUnits).where(and(eq(corpusUnits.corpusId, this.c.id), eq(corpusUnits.sourceId, sourceId))).orderBy(asc(corpusUnits.idx));
  }
  private async units(sourceId: string, fresh = false) {
    if (fresh || !this.unitsOf.has(sourceId)) this.unitsOf.set(sourceId, await this.loadUnits(sourceId));
    return this.unitsOf.get(sourceId)!;
  }

  /** Where a quote at `abs` in the source sits: its chunk, its unit, its chapter and the official PDF's page. */
  private async place(s: SrcRow, abs: number, absEnd: number, unitKey: string | null) {
    const list = await this.units(s.sourceId);
    const unit = (unitKey ? list.find((u) => u.key === unitKey) : null)
      ?? [...list].reverse().find((u) => PROVISION_KINDS.has(u.kind as Unit["kind"]) && u.charStart <= abs && abs < u.charEnd) ?? null;
    const ref = unit?.page != null ? await this.referencePages(s) : null;
    const locator: Record<string, unknown> = { charStart: abs, charEnd: absEnd, ...(unit ? { unit: unit.key } : {}), ...(ref && unit?.page ? { pdf: { sourceId: ref.sourceId, page: unit.page } } : {}) };
    return { chunkId: await this.chunkAt(s.sourceId, abs), unit, locator, chapter: unit?.chapter ?? null };
  }

  private chapterLabel(s: SrcRow, chapter: string | null): string | null {
    const crawl = (s.meta?.crawl ?? {}) as Record<string, unknown>;
    const short = typeof crawl.shortName === "string" ? crawl.shortName : null;
    if (s.role === "text") return chapter;
    return [short ?? s.title, chapter].filter(Boolean).join(": ") || null;
  }

  private async insertDefinitions(s: SrcRow, list: Pick<Unit, "key" | "start">[] | null, defs: { unitKey?: string | null; unit?: string | null; term: string; text: string; quote: string; at?: number }[], pass: number): Promise<number> {
    if (!defs.length) return 0;
    const existing = await db.select({ title: corpusRules.title }).from(corpusRules).where(and(eq(corpusRules.corpusId, this.c.id), eq(corpusRules.kind, "definition"), ne(corpusRules.status, "dropped")));
    const known = new Set(existing.map((e) => e.title.toLowerCase()));
    let n = 0;
    for (const d of defs) {
      if (known.has(d.term.toLowerCase())) continue;
      known.add(d.term.toLowerCase());
      const abs = d.at ?? s.text.indexOf(d.quote);
      if (abs < 0) continue;
      const key = d.unitKey ?? d.unit ?? null;
      const p = await this.place(s, abs, abs + d.quote.length, key);
      await db.insert(corpusRules).values({
        corpusId: this.c.id, graphId: this.v.graphId, ref: p.unit?.key ?? key ?? d.term, section: sectionOf(p.unit?.key ?? key ?? d.term), title: clip(d.term, 120), text: clip(d.text, 800),
        modality: "may", severity: "info", sourceId: s.sourceId, chunkId: p.chunkId, locator: p.locator, quote: clip(d.quote, 1600), status: "proposed", corpusVersion: this.c.version,
        kind: "definition", unitKey: p.unit?.key ?? key, chapter: this.chapterLabel(s, p.chapter), pass,
      });
      if (p.unit) await db.update(corpusUnits).set({ status: "definition" }).where(eq(corpusUnits.id, p.unit.id));
      n++;
    }
    void list;
    return n;
  }

  /** One model call with the run's bookkeeping. Null when mux is down (and the rest of the model work is skipped). */
  private async ask(pass: 2 | 3 | 4, messages: mux.MuxMessage[], maxTokens: number): Promise<unknown | null> {
    if (!(await this.mux())) return null;
    const m = this.w.model;
    // Each pass gets its share, so a huge text can't leave no calls for the completeness check and the summary.
    const share = { 2: 0.6, 3: 0.3, 4: 0.1 }[pass];
    const used = m.byPass[String(pass)] ?? 0;
    const cap = pass === 4 ? MODEL_BUDGET - m.calls : Math.floor(MODEL_BUDGET * share) + (pass === 3 ? Math.max(0, Math.floor(MODEL_BUDGET * 0.6) - (m.byPass["2"] ?? 0)) : 0);
    if (m.calls >= MODEL_BUDGET || used >= cap) {
      this.w.degraded = `This text is long: one run reads it with at most ${MODEL_BUDGET} model calls, and ${pass === 2 ? "some passages" : pass === 3 ? "some parts" : "the summaries"} wait for the next. Press Read again to continue where it stopped; nothing read is read twice.`;
      this.stopped.add(pass);
      return null;
    }
    const meta: mux.MuxCallMeta = { userId: this.v.id, agent: "my-graph:rule-reader", graphId: this.v.graphId, traceId: this.c.id };
    const t0 = Date.now();
    const chars = messages.reduce((a, x) => a + (typeof x.content === "string" ? x.content.length : 0), 0);
    for (let attempt = 0; attempt < 2; attempt++) {
      m.calls++; m.byPass[String(pass)] = (m.byPass[String(pass)] ?? 0) + 1; m.promptChars += chars;
      try {
        const r = await mux.complete({ route: "smart", json: true, maxTokens, temperature: 0, messages, meta });
        m.ms += Date.now() - t0; m.answerChars += r.text.length;
        if (r.model) m.models[r.model] = (m.models[r.model] ?? 0) + 1;
        return jsonOf(r.text);
      } catch (e) {
        m.failures++;
        if (mux.isMuxDown(e)) { this.muxUp = false; this.w.degraded = "The model gateway (mux) stopped answering during the reading. What was read is kept; press Read again to finish."; return null; }
        if (attempt === 1) { console.warn("[rules] a model call failed:", e instanceof Error ? e.message : e); return null; }
      }
    }
    return null;
  }

  /** Rules (and definitions) read from a passage, placed and stored as proposals. Returns how many were added. */
  private async keep(s: SrcRow, passageStart: number, ans: ReadAnswer, pass: 2 | 3, opts: { versionTops?: Set<string> } = {}): Promise<{ rules: number; defs: number }> {
    const existing = await db.select({ id: corpusRules.id, ref: corpusRules.ref, text: corpusRules.text, quote: corpusRules.quote, modality: corpusRules.modality, status: corpusRules.status, unitKey: corpusRules.unitKey })
      .from(corpusRules).where(and(eq(corpusRules.corpusId, this.c.id), inArray(corpusRules.status, ["proposed", "active"]), eq(corpusRules.kind, "rule")));
    const { kept } = dedupeRules(ans.rules, opts.versionTops ? existing.filter((e) => e.status === "proposed") : existing);
    let rules = 0;
    const vecTexts: { id: string; text: string }[] = [];
    const list = await this.units(s.sourceId);
    // A re-check reads whole passages, but only the units whose words changed may propose anything.
    const outside = (u: { key: string; parentKey: string | null; kind: string } | null) => !!opts.versionTops && (!u || !opts.versionTops.has(topOf(u, list)));
    for (const r of kept) {
      const abs = passageStart + r.quoteStart;
      const p = await this.place(s, abs, passageStart + r.quoteEnd, r.unit);
      if (outside(p.unit)) continue;
      const unitKey = p.unit?.key ?? r.unit;
      let change: string | null = null, supersedesId: string | null = null;
      if (opts.versionTops) {
        // A changed unit: compare with the rule in force there.
        const inForce = existing.filter((e) => e.status === "active" && e.unitKey === unitKey);
        // The same words as a rule in force: nothing changed, whatever the new reading calls it.
        if (inForce.some((e) => e.quote && overlap(e.quote, r.quote) >= 0.9)) continue;
        const d = diffVersion(inForce.map((e) => ({ ...e, quote: e.quote ?? null })), [r]);
        if (d.unchanged.length) continue;
        change = d.changed.length ? "changed" : "added";
        supersedesId = d.changed[0]?.from.id ?? null;
        if (this.w.changes) this.w.changes.proposed[change as "added" | "changed"]++;
      }
      const [row] = await db.insert(corpusRules).values({
        corpusId: this.c.id, graphId: this.v.graphId, ref: r.ref, section: sectionOf(unitKey ?? r.ref), title: r.title, text: r.text, modality: r.modality as Modality,
        appliesTo: r.appliesTo as Record<string, unknown>, checkHint: r.checkHint, severity: (r.severity ?? defaultSeverity(r.modality as Modality, this.c.binding as Binding)) as Severity,
        sourceId: s.sourceId, chunkId: p.chunkId, locator: p.locator, quote: r.quote, status: "proposed", change, supersedesId, corpusVersion: this.c.version,
        kind: "rule", unitKey, chapter: this.chapterLabel(s, p.chapter), confidence: r.confidence, pass,
        refs: ((p.unit?.refs ?? []) as Record<string, unknown>[]).slice(0, 20),
      }).returning({ id: corpusRules.id });
      if (p.unit) await db.update(corpusUnits).set({ status: "ruled" }).where(eq(corpusUnits.id, p.unit.id));
      vecTexts.push({ id: row.id, text: `${r.ref} ${r.title}. ${r.text}` });
      rules++;
    }
    const defsIn = opts.versionTops ? ans.definitions.filter((d) => { const u = list.find((x) => x.key === d.unit); return !outside(u ?? null); }) : ans.definitions;
    const defs = await this.insertDefinitions(s, null, defsIn.map((d) => ({ unit: d.unit, term: d.term, text: d.text, quote: d.quote, at: passageStart + d.quoteStart })), pass);
    if (vecTexts.length) {
      const vecs = await mux.embed(vecTexts.map((x) => x.text), { userId: this.v.id, agent: "my-graph:rule-reader", graphId: this.v.graphId }).catch(() => null);
      if (vecs) for (let i = 0; i < vecTexts.length; i++) if (vecs[i]?.length === 1024) await db.update(corpusRules).set({ embedding: vecs[i] }).where(eq(corpusRules.id, vecTexts[i].id));
    }
    return { rules, defs };
  }

  /* pass 2 */
  async extract(mode: "full" | "recheck", progress: (done: number, total: number) => Promise<void>): Promise<void> {
    const w = this.w;
    if (!(await this.mux())) { w.passes[2].status = "skipped"; await this.save(); return; }
    w.passes[2].status = "running";
    const srcs = await this.readingSources();
    type Job = { s: SrcRow; start: number; end: number; text: string; units: { key: string; label: string }[]; tops: string[] };
    const work: Job[] = [];
    let supporting = 0;
    for (const s of srcs) {
      if (s.role !== "text") { if (supporting > SUPPORTING_CHARS) continue; supporting += s.text.length; }
      const list = await this.units(s.sourceId, true);
      const asUnits = list.map((u) => ({ key: u.key, label: u.key, kind: u.kind as Unit["kind"], top: topOf(u, list), start: u.charStart, end: u.charEnd }));
      for (const p of passagesFor(s.text, asUnits, 3200)) {
        const fresh = list.filter((u) => p.tops.includes(topOf(u, list)) && !u.readAt);
        if (!fresh.length) continue;
        // In a re-check, the tops whose units are unread are the ones that changed.
        work.push({ s, start: p.start, end: p.end, text: p.text, units: p.units, tops: mode === "recheck" ? [...new Set(fresh.map((u) => topOf(u, list)))] : p.tops });
      }
    }
    w.passes[2].total = w.passes[2].done + work.length;
    await this.save();
    for (const j of work) {
      await progress(w.passes[2].done, w.passes[2].total);
      const raw = await this.ask(2, extractMessages({ set: this.set(), sourceTitle: j.s.title, passage: j.text, units: j.units, locale: this.locale, known: [] }), 6000);
      if (raw === null) { if (!this.muxUp || w.model.calls >= MODEL_BUDGET || this.stopped.has(2)) break; }
      else {
        try {
          const ans = parseReading(raw, j.text, j.units, { binding: this.c.binding as Binding });
          const kept = await this.keep(j.s, j.start, ans, 2, { versionTops: mode === "recheck" ? new Set(j.tops) : undefined });
          w.passes[2].rules += kept.rules; w.passes[2].definitions += kept.defs; w.passes[2].dropped += ans.dropped.length;
        } catch (e) {
          w.model.failures++;
          console.warn("[rules] pass 2 answer unusable:", e instanceof Error ? e.message : e);
        }
      }
      const list = await this.units(j.s.sourceId);
      const ids = list.filter((u) => j.tops.includes(topOf(u, list))).map((u) => u.id);
      if (ids.length) await db.update(corpusUnits).set({ readAt: new Date() }).where(inArray(corpusUnits.id, ids));
      for (const u of list) if (ids.includes(u.id)) u.readAt = new Date();
      w.passes[2].done++;
      await this.save();
    }
    w.passes[2].status = this.muxUp ? "done" : "failed";
    await this.save();
  }

  /** Coverage of all reading sources together (units and the rules read from them). */
  private async coverage(): Promise<{ report: CompletenessReport; bySource: Map<string, { units: Awaited<ReturnType<Runner["loadUnits"]>>; rules: { unitKey: string | null; kind: string; status: string; confidence: number | null }[] }> }> {
    const srcs = await this.readingSources();
    const bySource = new Map<string, { units: Awaited<ReturnType<Runner["loadUnits"]>>; rules: { unitKey: string | null; kind: string; status: string; confidence: number | null }[] }>();
    const allUnits: Parameters<typeof coverageOf>[0] = [];
    const allRules: Parameters<typeof coverageOf>[1] = [];
    for (const s of srcs) {
      const units = await this.units(s.sourceId, true);
      const rules = await db.select({ unitKey: corpusRules.unitKey, kind: corpusRules.kind, status: corpusRules.status, confidence: corpusRules.confidence }).from(corpusRules)
        .where(and(eq(corpusRules.corpusId, this.c.id), eq(corpusRules.sourceId, s.sourceId), ne(corpusRules.status, "dropped"), ne(corpusRules.status, "retired")));
      bySource.set(s.sourceId, { units, rules });
      const prefix = s.role === "text" ? "" : `${s.sourceId}:`;
      allUnits.push(...units.map((u) => ({ key: prefix + u.key, kind: u.kind as Unit["kind"], parentKey: u.parentKey ? prefix + u.parentKey : null, top: prefix + topOf(u, units), flags: u.flags as Unit["flags"], note: u.note, chapter: u.chapter })));
      allRules.push(...rules.map((r) => ({ ...r, unitKey: r.unitKey ? prefix + r.unitKey : null })));
    }
    return { report: coverageOf(allUnits, allRules), bySource };
  }

  /* pass 3 */
  async complete(mode: "full" | "recheck", progress: (done: number, total: number) => Promise<void>): Promise<void> {
    const w = this.w;
    if (!(await this.mux())) { w.passes[3].status = "skipped"; await this.save(); return; }
    w.passes[3].status = "running";
    await this.save();
    const srcs = await this.readingSources();
    const { bySource } = await this.coverage();
    type Job = { s: SrcRow; top: string };
    const work: Job[] = [];
    for (const s of srcs) {
      const b = bySource.get(s.sourceId);
      if (!b) continue;
      const cu = b.units.map((u) => ({ key: u.key, kind: u.kind as Unit["kind"], parentKey: u.parentKey, top: topOf(u, b.units), flags: u.flags as Unit["flags"], note: u.note, chapter: u.chapter }));
      const tops = mode === "recheck" ? rereadList(cu, b.rules).filter((t) => b.units.some((u) => u.key === t && !u.rereadAt)) : rereadList(cu, b.rules, 80);
      for (const t of tops) if (!b.units.find((u) => u.key === t)?.rereadAt) work.push({ s, top: t });
    }
    w.passes[3].total = w.passes[3].done + work.length;
    await this.save();
    for (const j of work) {
      await progress(w.passes[3].done, w.passes[3].total);
      const list = await this.units(j.s.sourceId);
      const top = list.find((u) => u.key === j.top);
      if (!top) { w.passes[3].done++; continue; }
      const members = list.filter((u) => topOf(u, list) === j.top);
      const text = j.s.text.slice(top.charStart, Math.min(top.charEnd, top.charStart + 9000));
      const found = (await db.select({ ref: corpusRules.ref, title: corpusRules.title, kind: corpusRules.kind }).from(corpusRules)
        .where(and(eq(corpusRules.corpusId, this.c.id), eq(corpusRules.sourceId, j.s.sourceId), ne(corpusRules.status, "dropped"), inArray(corpusRules.unitKey, members.map((m) => m.key)))))
        .map((r) => `${r.kind === "definition" ? "definition " : ""}${r.ref}: ${r.title}`);
      const raw = await this.ask(3, rereadMessages({ set: this.set(), sourceTitle: j.s.title, passage: text, units: members.map((m) => ({ key: m.key, label: m.key, flags: m.flags as string[] })), found, locale: this.locale }), 6000);
      if (raw === null) { if (!this.muxUp || w.model.calls >= MODEL_BUDGET || this.stopped.has(3)) break; }
      else {
        try {
          const ans = parseReading(raw, text, members, { binding: this.c.binding as Binding });
          const kept = await this.keep(j.s, top.charStart, ans, 3, { versionTops: mode === "recheck" ? new Set([j.top]) : undefined });
          w.passes[3].rules += kept.rules; w.passes[3].definitions += kept.defs; w.passes[3].dropped += ans.dropped.length;
          for (const n of ans.noRule) {
            const u = members.find((m) => m.key === n.unit);
            if (u && u.status === "open") { const note = noRuleCode(n.reason);
              await db.update(corpusUnits).set({ status: "no_rule", note }).where(eq(corpusUnits.id, u.id)); u.status = "no_rule"; u.note = note; w.passes[3].noRule++; }
          }
        } catch (e) {
          w.model.failures++;
          console.warn("[rules] pass 3 answer unusable:", e instanceof Error ? e.message : e);
        }
      }
      await db.update(corpusUnits).set({ rereadAt: new Date() }).where(inArray(corpusUnits.id, members.map((m) => m.id)));
      for (const m of members) m.rereadAt = new Date();
      w.passes[3].done++;
      await this.save();
    }
    w.passes[3].status = this.muxUp ? "done" : "failed";
    await this.save();
  }

  /* pass 4 */
  async understand(progress: (done: number, total: number) => Promise<void>): Promise<void> {
    const w = this.w;
    w.passes[4].status = "running";
    await this.save();
    // 1. The same rule read from two documents (an executive order repeating the act): the act's reading is kept.
    const proposed = await db.select().from(corpusRules).where(and(eq(corpusRules.corpusId, this.c.id), eq(corpusRules.status, "proposed"), eq(corpusRules.kind, "rule"), isNull(corpusRules.change)));
    const textIds = new Set((await this.readingSources()).filter((s) => s.role === "text").map((s) => s.sourceId));
    const ordered = [...proposed.filter((r) => r.sourceId && textIds.has(r.sourceId)), ...proposed.filter((r) => !r.sourceId || !textIds.has(r.sourceId))];
    const { duplicates } = dedupeRules(ordered.map((r) => ({ ...r, quote: r.quote })));
    if (duplicates.length) await db.update(corpusRules).set({ status: "dropped", updatedAt: new Date() }).where(inArray(corpusRules.id, duplicates.map((d) => d.id)));
    w.passes[4].merged = duplicates.length;
    // 2. Guidance read as interpretation of the rules it talks about.
    const guidance = await db.select({ sourceId: corpusSources.sourceId, title: sources.title, url: sources.url }).from(corpusSources).innerJoin(sources, eq(sources.id, corpusSources.sourceId))
      .where(and(eq(corpusSources.corpusId, this.c.id), eq(corpusSources.role, "interpretation")));
    let interpretations = 0;
    if (guidance.length) {
      const main = (await this.readingSources()).find((s) => s.role === "text");
      const family: Family = main ? detectFamily(main.text) : "dk";
      const mainUnits = main ? await this.units(main.sourceId, true) : [];
      const topKeys = new Set(mainUnits.filter((u) => TOP_KINDS.has(u.kind as Unit["kind"])).map((u) => u.key));
      const gChunks = await db.select({ id: chunks.id, sourceId: chunks.sourceId, text: chunks.text }).from(chunks).where(inArray(chunks.sourceId, guidance.map((g) => g.sourceId))).limit(4000);
      const links = interpretationLinks(gChunks, topKeys, family);
      const titles = new Map(guidance.map((g) => [g.sourceId, g]));
      const rules = await db.select({ id: corpusRules.id, unitKey: corpusRules.unitKey, sourceId: corpusRules.sourceId }).from(corpusRules).where(and(eq(corpusRules.corpusId, this.c.id), inArray(corpusRules.status, ["proposed", "active"])));
      for (const r of rules) {
        if (!r.unitKey || r.sourceId !== main?.sourceId) continue;
        const top = topOf(mainUnits.find((u) => u.key === r.unitKey) ?? { key: r.unitKey, parentKey: null, kind: "paragraph" }, mainUnits);
        const list = links.get(top);
        if (!list?.length) continue;
        await db.update(corpusRules).set({ interpretation: list.map((l) => ({ ...l, title: titles.get(l.sourceId)?.title ?? null, url: titles.get(l.sourceId)?.url ?? null })) }).where(eq(corpusRules.id, r.id));
        interpretations++;
      }
    }
    w.passes[4].interpretations = interpretations;
    await this.save();
    // 3. What it means: per chapter and for the whole set, and what stays open.
    const all = await db.select({ ref: corpusRules.ref, text: corpusRules.text, modality: corpusRules.modality, chapter: corpusRules.chapter, kind: corpusRules.kind }).from(corpusRules)
      .where(and(eq(corpusRules.corpusId, this.c.id), inArray(corpusRules.status, ["proposed", "active"]), eq(corpusRules.kind, "rule")));
    const byChapter = new Map<string, string[]>();
    for (const r of all) {
      const k = r.chapter ?? this.c.name;
      byChapter.set(k, [...(byChapter.get(k) ?? []), `${r.ref} (${r.modality.replace("_", " ")}): ${r.text}`]);
    }
    const chapters = [...byChapter.entries()].map(([chapter, rules]) => ({ chapter, rules }));
    const batches: { chapter: string; rules: string[] }[][] = [];
    let cur: { chapter: string; rules: string[] }[] = [], size = 0;
    for (const ch of chapters) {
      const n = ch.rules.join("\n").length;
      if (cur.length && size + n > 9000) { batches.push(cur); cur = []; size = 0; }
      cur.push({ chapter: ch.chapter, rules: ch.rules.slice(0, 60) }); size += Math.min(n, 9000);
    }
    if (cur.length) batches.push(cur);
    const out: Understanding = { chapters: [], overall: null, openQuestions: [] };
    const related = w.crawl.related.map((r) => `${r.shortName || r.title} (${r.relation})`).slice(0, 10);
    w.passes[4].total = batches.length + (batches.length > 1 ? 1 : 0);
    if (all.length && (await this.mux())) {
      for (const [i, b] of batches.entries()) {
        await progress(i, w.passes[4].total);
        const whole = batches.length === 1;
        const raw = await this.ask(4, understandMessages({ set: this.set(), chapters: b, locale: this.locale, whole, related }), 2500);
        if (raw) { try { const u = parseUnderstanding(raw); out.chapters.push(...u.chapters); if (whole) { out.overall = u.overall; out.openQuestions = u.openQuestions; } } catch { w.model.failures++; } }
        w.passes[4].done++;
        await this.save();
      }
      if (batches.length > 1) {
        const raw = await this.ask(4, understandMessages({ set: this.set(), chapters: out.chapters.map((c) => ({ chapter: c.chapter, rules: [c.summary] })), locale: this.locale, whole: true, related }), 2000);
        if (raw) { try { const u = parseUnderstanding(raw); out.overall = u.overall; out.openQuestions = u.openQuestions; } catch { w.model.failures++; } }
        w.passes[4].done++;
      }
    }
    w.passes[4].summaries = out.chapters.length + (out.overall ? 1 : 0);
    // 4. The completeness report.
    const { report } = await this.coverage();
    const state: UnderstandingState = { ...out, report, at: now() };
    if (!out.overall && !out.chapters.length) {
      const prev = (this.c.understanding ?? null) as UnderstandingState | null;
      if (prev) { state.chapters = prev.chapters ?? []; state.overall = prev.overall ?? null; state.openQuestions = prev.openQuestions ?? []; }
    }
    await db.update(corpora).set({ understanding: state as unknown as Record<string, unknown>, readState: { status: "done", mode: "read", done: w.passes[2].done, total: w.passes[2].total, found: w.passes[2].rules + w.passes[3].rules, dropped: w.passes[2].dropped, at: w.startedAt, finishedAt: now() } }).where(eq(corpora.id, this.c.id));
    await db.update(corpusSources).set({ readAt: new Date() }).where(eq(corpusSources.corpusId, this.c.id));
    w.passes[4].status = "done";
    await this.save();
  }
}

/** The top unit (§ / article / clause) a unit belongs to, from the stored parent links. */
function topOf(u: { key: string; parentKey: string | null; kind: string }, list: { key: string; parentKey: string | null; kind: string }[]): string {
  let x: { key: string; parentKey: string | null; kind: string } | undefined = u;
  const byKey = new Map(list.map((l) => [l.key, l]));
  for (let i = 0; x && i < 8; i++) {
    if (TOP_KINDS.has(x.kind as Unit["kind"]) && !(x.kind === "annex" && list.some((l) => l.parentKey === x!.key && TOP_KINDS.has(l.kind as Unit["kind"])))) return x.key;
    x = x.parentKey ? byKey.get(x.parentKey) : undefined;
  }
  return u.key;
}

export { LOW_CONFIDENCE };
