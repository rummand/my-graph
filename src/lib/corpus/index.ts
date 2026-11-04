/**
 * Corpora (server-only): bodies of rules the current graph follows — legislation, an authority's interpretation
 * guide, the architecture board's governance, guardrails. A corpus is a node in the graph (type document, kind
 * "corpus") plus a `corpora` row; its rules are read from its sources by mux, one passage at a time, and wait as
 * `proposed` until a person approves, edits or drops them on the corpus page.
 *
 * Why not a change set: the changes library's ops (src/lib/changes) cover nodes, edges, the meta model, reminders and
 * wiki pages. A rule is none of those (it is a row with its own lifecycle and an embedding), and a generic op would
 * be delivered by code that doesn't know how to apply it. So rules keep their own review screen with the same rule:
 * agents propose, a person decides, and every decision is recorded in the graph's history (graph_events on the
 * corpus node) and the activity log.
 *
 * Everything is scoped to the viewer's current graph.
 */
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { chunks, corpora, corpusRules, corpusSources, sources } from "@/db/schema";
import { isParent, type Viewer } from "@/lib/auth";
import { scopeOf } from "@/lib/graphs/pure";
import * as gbrain from "@/lib/gbrain";
import * as mux from "@/lib/mux";
import { sourceVisibleTo } from "@/lib/ingest/access";
import { logActivity } from "@/lib/automations";
import { recordEvent, stampFor } from "@/lib/history/record";
import { localeOf } from "@/lib/assistant/locale";
import { extractionMessages } from "./prompt";
import {
  chunkOfQuote, compareSections, coverage, dedupeRules, defaultSeverity, diffVersion, parseExtraction, passagesOf, readScope, sectionOf,
  type Binding, type CorpusKind, type CorpusScope, type CorpusStatus, type Modality, type RuleCandidate, type Severity, type SourceRole,
} from "./pure";

export * from "./pure";

export class CorpusError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/* ── Views ──────────────────────────────────────────────────────────────────────────────────────────────── */

export type ReadState = { status: "running" | "done" | "failed"; mode: "read" | "version"; done: number; total: number; found: number; dropped: number; error?: string | null; at: string; finishedAt?: string | null };

export type CorpusSummary = {
  id: string; nodeId: string | null; name: string; description: string | null; kind: CorpusKind; authority: string | null; binding: Binding;
  version: string | null; effectiveFrom: string | null; effectiveTo: string | null; status: CorpusStatus; scope: CorpusScope; checkByDefault: boolean;
  rulesVersion: number; readState: ReadState | null; counts: { active: number; proposed: number; retired: number }; sources: number;
  updatedAt: string; createdAt: string;
};

export type RuleView = {
  id: string; corpusId: string; ref: string; section: string; title: string; text: string; modality: Modality; severity: Severity;
  checkHint: string | null; appliesTo: CorpusScope; status: string; change: string | null; supersedesId: string | null; corpusVersion: string | null;
  /** Hidden when the viewer can't open the source. */
  quote: string | null; sourceId: string | null; sourceTitle: string | null; chunkId: string | null; locator: Record<string, unknown>; sourceHidden: boolean;
  createdAt: string; decidedAt: string | null;
};

export type CorpusSourceView = { id: string; sourceId: string; title: string; kind: string; url: string | null; status: string; role: SourceRole | string; readAt: string | null; corpusVersion: string | null };

export type CorpusDetail = CorpusSummary & { sources_: CorpusSourceView[]; rules: RuleView[]; canManage: boolean };

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/** People who may build corpora and decide their rules: anyone who may write in the graph (not children in a family graph). */
export function canManageCorpora(v: Viewer): boolean {
  const s = scopeOf(v);
  return s.canWrite && (!s.family || isParent(v));
}

function assertManage(v: Viewer) {
  if (!canManageCorpora(v)) throw new CorpusError(403, "Only people who may change this graph can build corpora and decide their rules.");
}

type CorpusRow = typeof corpora.$inferSelect;

function summary(r: CorpusRow, counts: CorpusSummary["counts"], nSources: number): CorpusSummary {
  return {
    id: r.id, nodeId: r.nodeId, name: r.name, description: r.description, kind: r.kind as CorpusKind, authority: r.authority, binding: r.binding as Binding,
    version: r.version, effectiveFrom: iso(r.effectiveFrom), effectiveTo: iso(r.effectiveTo), status: r.status as CorpusStatus, scope: readScope(r.scope),
    checkByDefault: r.checkByDefault, rulesVersion: r.rulesVersion, readState: (r.readState as ReadState | null) ?? null, counts, sources: nSources,
    updatedAt: r.updatedAt.toISOString(), createdAt: r.createdAt.toISOString(),
  };
}

async function own(v: Viewer, id: string): Promise<CorpusRow> {
  if (!gbrain.isUuid(id)) throw new CorpusError(404, "That corpus isn't here.");
  const [r] = await db.select().from(corpora).where(and(eq(corpora.id, id), eq(corpora.graphId, v.graphId))).limit(1);
  if (!r) throw new CorpusError(404, "That corpus isn't here.");
  return r;
}

/* ── Reading ────────────────────────────────────────────────────────────────────────────────────────────── */

export async function listCorpora(v: Viewer): Promise<CorpusSummary[]> {
  const rows = await db.select().from(corpora).where(eq(corpora.graphId, v.graphId)).orderBy(desc(corpora.updatedAt));
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const [ruleRows, srcRows] = await Promise.all([
    db.select({ corpusId: corpusRules.corpusId, status: corpusRules.status, n: sql<number>`count(*)::int` }).from(corpusRules)
      .where(and(inArray(corpusRules.corpusId, ids), eq(corpusRules.graphId, v.graphId))).groupBy(corpusRules.corpusId, corpusRules.status),
    db.select({ corpusId: corpusSources.corpusId, n: sql<number>`count(*)::int` }).from(corpusSources)
      .where(and(inArray(corpusSources.corpusId, ids), eq(corpusSources.graphId, v.graphId))).groupBy(corpusSources.corpusId),
  ]);
  return rows.map((r) => {
    const mine = ruleRows.filter((x) => x.corpusId === r.id);
    const n = (s: string) => mine.find((x) => x.status === s)?.n ?? 0;
    return summary(r, { active: n("active"), proposed: n("proposed"), retired: n("retired") }, srcRows.find((x) => x.corpusId === r.id)?.n ?? 0);
  });
}

async function readableSourceIds(v: Viewer, ids: string[]): Promise<Set<string>> {
  const list = [...new Set(ids.filter(Boolean))];
  if (!list.length) return new Set();
  const rows = await db.select({ id: sources.id }).from(sources).where(and(inArray(sources.id, list), sourceVisibleTo(v)));
  return new Set(rows.map((r) => r.id));
}

type RuleRow = typeof corpusRules.$inferSelect;

function ruleView(r: RuleRow, titles: Map<string, string>, readable: Set<string>): RuleView {
  const hidden = !!r.sourceId && !readable.has(r.sourceId);
  return {
    id: r.id, corpusId: r.corpusId, ref: r.ref, section: r.section ?? sectionOf(r.ref), title: r.title, text: r.text, modality: r.modality as Modality,
    severity: r.severity as Severity, checkHint: r.checkHint, appliesTo: readScope(r.appliesTo), status: r.status, change: r.change, supersedesId: r.supersedesId,
    corpusVersion: r.corpusVersion,
    quote: hidden ? null : r.quote, sourceId: hidden ? null : r.sourceId, sourceTitle: hidden ? null : (r.sourceId ? titles.get(r.sourceId) ?? null : null),
    chunkId: hidden ? null : r.chunkId, locator: hidden ? {} : (r.locator as Record<string, unknown>) ?? {}, sourceHidden: hidden,
    createdAt: r.createdAt.toISOString(), decidedAt: iso(r.decidedAt),
  };
}

export async function getCorpus(v: Viewer, id: string): Promise<CorpusDetail> {
  const r = await own(v, id);
  const [srcs, rules] = await Promise.all([
    db.select({ id: corpusSources.id, sourceId: corpusSources.sourceId, role: corpusSources.role, readAt: corpusSources.readAt, corpusVersion: corpusSources.corpusVersion,
      title: sources.title, kind: sources.kind, url: sources.url, status: sources.status })
      .from(corpusSources).innerJoin(sources, eq(sources.id, corpusSources.sourceId))
      .where(and(eq(corpusSources.corpusId, id), eq(corpusSources.graphId, v.graphId))).orderBy(asc(corpusSources.createdAt)),
    db.select().from(corpusRules).where(and(eq(corpusRules.corpusId, id), eq(corpusRules.graphId, v.graphId), ne(corpusRules.status, "dropped"))),
  ]);
  const readable = await readableSourceIds(v, [...srcs.map((s) => s.sourceId), ...rules.map((x) => x.sourceId ?? "")]);
  const titles = new Map(srcs.map((s) => [s.sourceId, s.title]));
  const visibleSources = srcs.filter((s) => readable.has(s.sourceId));
  rules.sort((a, b) => compareSections(a.section ?? sectionOf(a.ref), b.section ?? sectionOf(b.ref)) || a.ref.localeCompare(b.ref, "da", { numeric: true }) || a.createdAt.getTime() - b.createdAt.getTime());
  return {
    ...summary(r, coverage(rules), srcs.length),
    sources_: visibleSources.map((s) => ({ id: s.id, sourceId: s.sourceId, title: s.title, kind: s.kind, url: s.url, status: s.status, role: s.role, readAt: iso(s.readAt), corpusVersion: s.corpusVersion })),
    rules: rules.map((x) => ruleView(x, titles, readable)),
    canManage: canManageCorpora(v),
  };
}

/* ── Writing the corpus ─────────────────────────────────────────────────────────────────────────────────── */

export type CorpusInput = {
  name: string; description?: string | null; kind: CorpusKind; authority?: string | null; binding: Binding; version?: string | null;
  effectiveFrom?: string | null; effectiveTo?: string | null; status?: CorpusStatus; scope?: CorpusScope; checkByDefault?: boolean;
};

const PERSON = (v: Viewer) => ({ activity: "manual_edit" as const, agentType: "user" as const, agentId: v.id });

function nodeProps(i: { authority?: string | null; binding?: string; version?: string | null; effectiveFrom?: string | null }) {
  const p: Record<string, unknown> = {};
  if (i.authority) p.authority = i.authority;
  if (i.binding) p.binding = i.binding;
  if (i.version) p.version = i.version;
  if (i.effectiveFrom) p.effective_from = i.effectiveFrom.slice(0, 10);
  return p;
}

const dateOrNull = (s: string | null | undefined) => (s ? new Date(s) : null);

async function history(v: Viewer, c: Pick<CorpusRow, "nodeId" | "name" | "graphId">, field: string, from: unknown, to: unknown, actor: "person" | "assistant" = "person") {
  if (!c.nodeId) return;
  await recordEvent(db, c.graphId, { subjectType: "node", subjectId: c.nodeId, subjectName: c.name, kind: "updated", field, fromValue: from, toValue: to },
    stampFor({ actor: actor === "person" ? { kind: "person", id: v.id, name: v.name } : { kind: "assistant", id: null, name: "Rule reader" }, context: "corpus" }));
}

export async function createCorpus(v: Viewer, input: CorpusInput): Promise<CorpusSummary> {
  assertManage(v);
  const name = input.name.trim();
  if (!name) throw new CorpusError(400, "Give the corpus a name.");
  let nodeId: string | null = null;
  try {
    const { node } = await gbrain.upsertNode(v, {
      id: randomUUID(), type: "document", kind: "corpus", label: name, summary: input.description?.trim() || undefined,
      props: nodeProps(input), visibility: "household",
    }, { ...PERSON(v), note: "Corpus created" });
    nodeId = node.id;
  } catch (e) {
    console.error("[corpus] the corpus node could not be made:", e instanceof Error ? e.message : e);
  }
  const [row] = await db.insert(corpora).values({
    graphId: v.graphId, nodeId, name, description: input.description?.trim() || null, kind: input.kind, authority: input.authority?.trim() || null,
    binding: input.binding, version: input.version?.trim() || null, effectiveFrom: dateOrNull(input.effectiveFrom), effectiveTo: dateOrNull(input.effectiveTo),
    status: input.status ?? "draft", scope: (input.scope ?? { all: true }) as Record<string, unknown>, checkByDefault: input.checkByDefault ?? true, createdBy: v.id,
  }).returning();
  void logActivity({ graphId: v.graphId, userId: v.id, actor: "wiki", action: "created_corpus", summary: `Started the corpus "${name}"`, subjectType: "corpus", subjectId: row.id, visibility: "household" });
  return summary(row, { active: 0, proposed: 0, retired: 0 }, 0);
}

export async function updateCorpus(v: Viewer, id: string, patch: Partial<CorpusInput>): Promise<CorpusSummary> {
  assertManage(v);
  const cur = await own(v, id);
  const set: Partial<typeof corpora.$inferInsert> = { updatedAt: new Date() };
  if (patch.name !== undefined) set.name = patch.name.trim() || cur.name;
  if (patch.description !== undefined) set.description = patch.description?.trim() || null;
  if (patch.kind) set.kind = patch.kind;
  if (patch.authority !== undefined) set.authority = patch.authority?.trim() || null;
  if (patch.binding) set.binding = patch.binding;
  if (patch.version !== undefined) set.version = patch.version?.trim() || null;
  if (patch.effectiveFrom !== undefined) set.effectiveFrom = dateOrNull(patch.effectiveFrom);
  if (patch.effectiveTo !== undefined) set.effectiveTo = dateOrNull(patch.effectiveTo);
  if (patch.status) set.status = patch.status;
  if (patch.scope) set.scope = patch.scope as Record<string, unknown>;
  if (patch.checkByDefault !== undefined) set.checkByDefault = patch.checkByDefault;
  // Scope, status and binding change what a check uses: old cached checks must not be reused.
  if (patch.status || patch.scope || patch.binding) set.rulesVersion = cur.rulesVersion + 1;
  const [row] = await db.update(corpora).set(set).where(and(eq(corpora.id, id), eq(corpora.graphId, v.graphId))).returning();
  if (cur.nodeId) {
    const nodePatch: Partial<gbrain.NodeInput> = {};
    if (set.name && set.name !== cur.name) nodePatch.label = set.name;
    if (patch.description !== undefined) nodePatch.summary = set.description ?? "";
    const props = nodeProps({ authority: row.authority, binding: row.binding, version: row.version, effectiveFrom: iso(row.effectiveFrom) });
    nodePatch.props = props;
    try { await gbrain.updateNode(v, cur.nodeId, nodePatch, { ...PERSON(v), note: "Corpus details changed" }); } catch (e) { console.warn("[corpus] node update failed:", e instanceof Error ? e.message : e); }
  }
  if (patch.status && patch.status !== cur.status) await history(v, row, "corpus.status", cur.status, patch.status);
  return summary(row, { active: 0, proposed: 0, retired: 0 }, 0);
}

export async function deleteCorpus(v: Viewer, id: string): Promise<void> {
  assertManage(v);
  const cur = await own(v, id);
  await db.delete(corpora).where(and(eq(corpora.id, id), eq(corpora.graphId, v.graphId)));
  if (cur.nodeId) { try { await gbrain.retireNode(v, cur.nodeId, { ...PERSON(v), note: "Corpus deleted" }); } catch { /* the node may be gone already */ } }
}

/* ── Sources ────────────────────────────────────────────────────────────────────────────────────────────── */

export async function addSources(v: Viewer, id: string, sourceIds: string[], opts: { role?: SourceRole } = {}): Promise<number> {
  assertManage(v);
  const c = await own(v, id);
  const ok = await readableSourceIds(v, sourceIds);
  const list = sourceIds.filter((s) => ok.has(s));
  if (!list.length) throw new CorpusError(404, "Those documents aren't in this graph's library, or you can't open them.");
  const rows = await db.insert(corpusSources).values(list.map((sourceId) => ({ corpusId: id, graphId: v.graphId, sourceId, role: opts.role ?? "text", corpusVersion: c.version })))
    .onConflictDoNothing().returning({ id: corpusSources.id, sourceId: corpusSources.sourceId });
  await db.update(corpora).set({ updatedAt: new Date() }).where(eq(corpora.id, id));
  // The corpus node is derived from its documents: the graph shows where the rules come from.
  if (c.nodeId && rows.length) {
    const docs = await db.select({ nodeId: sources.nodeId }).from(sources).where(and(inArray(sources.id, rows.map((r) => r.sourceId)), isNotNull(sources.nodeId)));
    for (const d of docs) {
      try { await gbrain.addEdge(v, { fromId: c.nodeId, toId: d.nodeId!, relation: "derived_from", status: "confirmed" }, { ...PERSON(v), note: "Corpus source" }); } catch { /* best effort */ }
    }
  }
  return rows.length;
}

/** Read a web page with the web pipeline (saved as a web source in the library) and add it to the corpus. */
export async function addUrl(v: Viewer, id: string, url: string, opts: { role?: SourceRole } = {}): Promise<{ sourceId: string; title: string }> {
  assertManage(v);
  await own(v, id);
  const { readUrl } = await import("@/lib/web");
  let page: Awaited<ReturnType<typeof readUrl>>;
  try {
    page = await readUrl(v, url);
  } catch (e) {
    throw new CorpusError(400, e instanceof Error ? e.message : "That page couldn't be read.");
  }
  await addSources(v, id, [page.sourceId], opts);
  return { sourceId: page.sourceId, title: page.title };
}

export async function removeSource(v: Viewer, id: string, sourceId: string): Promise<void> {
  assertManage(v);
  await own(v, id);
  await db.delete(corpusSources).where(and(eq(corpusSources.corpusId, id), eq(corpusSources.sourceId, sourceId), eq(corpusSources.graphId, v.graphId)));
}

/* ── Reading rules ──────────────────────────────────────────────────────────────────────────────────────── */

const READ_STALE_MS = 20 * 60 * 1000;
const MAX_PASSAGES = 40;

async function setReadState(id: string, s: ReadState) {
  await db.update(corpora).set({ readState: s as unknown as Record<string, unknown>, updatedAt: new Date() }).where(eq(corpora.id, id));
}

/**
 * "Read rules": mux (route smart) reads every passage of the corpus's sources and proposes rules, each with its exact
 * quote and where it is. `mode: "version"` compares what it reads with the rules in force and proposes the difference
 * (added, changed, removed) for the new version. Runs in the background; progress is on the corpus row.
 */
export async function startReading(v: Viewer, id: string, opts: { mode?: "read" | "version"; version?: string | null } = {}): Promise<ReadState> {
  assertManage(v);
  const c = await own(v, id);
  const prev = c.readState as ReadState | null;
  if (prev?.status === "running" && Date.now() - new Date(prev.at).getTime() < READ_STALE_MS) throw new CorpusError(409, "The rules are being read already.");
  const srcCount = await db.select({ n: sql<number>`count(*)::int` }).from(corpusSources).where(and(eq(corpusSources.corpusId, id), eq(corpusSources.graphId, v.graphId)));
  if (!srcCount[0]?.n) throw new CorpusError(400, "Add the documents the rules are in first.");
  const mode = opts.mode ?? "read";
  if (mode === "version" && opts.version) {
    await db.update(corpora).set({ version: opts.version.trim() }).where(eq(corpora.id, id));
  }
  const state: ReadState = { status: "running", mode, done: 0, total: 0, found: 0, dropped: 0, at: new Date().toISOString(), finishedAt: null, error: null };
  await setReadState(id, state);
  void readRules(v, id, mode).catch(async (e) => {
    console.error("[corpus] reading rules failed:", e);
    await setReadState(id, { ...state, status: "failed", error: e instanceof Error ? e.message.slice(0, 300) : "Reading failed.", finishedAt: new Date().toISOString() }).catch(() => {});
  });
  return state;
}

/** Wait (a little) for a source the library is still reading. */
async function readySource(sourceId: string, maxMs = 180_000): Promise<string> {
  const until = Date.now() + maxMs;
  for (;;) {
    const [s] = await db.select({ status: sources.status }).from(sources).where(eq(sources.id, sourceId)).limit(1);
    if (!s) return "gone";
    if (s.status === "ready" || s.status === "failed" || Date.now() > until) return s.status;
    await new Promise((r) => setTimeout(r, 3000));
  }
}

type Located = Omit<RuleCandidate, "chunkId" | "sourceId"> & { sourceId: string; chunkId: string | null; locator: Record<string, unknown> };

async function readRules(v: Viewer, id: string, mode: "read" | "version"): Promise<void> {
  const c = await own(v, id);
  const locale = await localeOf(v.id);
  const srcs = await db.select({ sourceId: corpusSources.sourceId, title: sources.title, sensitive: sources.sensitive })
    .from(corpusSources).innerJoin(sources, eq(sources.id, corpusSources.sourceId))
    .where(and(eq(corpusSources.corpusId, id), eq(corpusSources.graphId, v.graphId)));
  const readable = await readableSourceIds(v, srcs.map((s) => s.sourceId));

  // Every passage of every source, in order, before any model call (so progress has a total).
  const work: { sourceId: string; title: string; sensitive: boolean; passage: ReturnType<typeof passagesOf>[number] }[] = [];
  for (const s of srcs) {
    if (!readable.has(s.sourceId)) continue;
    await readySource(s.sourceId);
    const rows = await db.select({ id: chunks.id, text: chunks.text, locator: chunks.locator }).from(chunks)
      .where(and(eq(chunks.sourceId, s.sourceId), eq(chunks.graphId, v.graphId))).orderBy(asc(chunks.idx));
    let list = rows.map((r) => ({ id: r.id, text: r.text, locator: (r.locator ?? {}) as Record<string, unknown> }));
    if (!list.length) {
      // No passages (yet): read the stored text in one go.
      const [src] = await db.select({ text: sources.textContent }).from(sources).where(eq(sources.id, s.sourceId));
      if (src?.text?.trim()) list = [{ id: "", text: src.text.slice(0, 60_000), locator: {} }];
    }
    for (const p of passagesOf(list)) work.push({ sourceId: s.sourceId, title: s.title, sensitive: s.sensitive, passage: p });
  }
  const limited = work.slice(0, MAX_PASSAGES);
  const state: ReadState = { status: "running", mode, done: 0, total: limited.length, found: 0, dropped: 0, at: new Date().toISOString(), finishedAt: null, error: null };
  await setReadState(id, state);

  const existing = await db.select().from(corpusRules).where(and(eq(corpusRules.corpusId, id), inArray(corpusRules.status, ["proposed", "active"])));
  const found: Located[] = [];
  let failures = 0;
  for (const w of limited) {
    const known = [...existing, ...found].map((r) => `${r.ref}: ${r.title}`);
    try {
      const out = await mux.completeJson({
        route: "smart", maxTokens: 3000,
        messages: extractionMessages({ corpus: { name: c.name, kind: c.kind, authority: c.authority, binding: c.binding as Binding }, sourceTitle: w.title, passage: w.passage.text, locale, known: mode === "version" ? [] : known }),
        parse: (raw) => parseExtraction(raw, w.passage.text, { binding: c.binding as Binding }),
        meta: { userId: v.id, agent: "my-graph:corpus-reader", sensitive: w.sensitive, graphId: v.graphId, traceId: id },
      });
      for (const r of out.rules) {
        const at = w.passage.chunkIds[0] ? chunkOfQuote(w.passage, r.quoteStart, r.quoteEnd) : null;
        found.push({ ...r, sourceId: w.sourceId, chunkId: at?.chunkId || null, locator: at?.locator ?? {} });
      }
      state.dropped += out.dropped.length;
    } catch (e) {
      failures++;
      if (mux.isMuxDown(e)) { state.error = "The model gateway (mux) can't be reached, so the rules can't be read right now."; break; }
      console.warn("[corpus] a passage could not be read:", e instanceof Error ? e.message : e);
    }
    state.done++;
    state.found = found.length;
    await setReadState(id, state);
  }

  // Deduplicate across sources and passages (a guide quoting the law states the same rule twice).
  const { kept } = dedupeRules(found, mode === "read" ? existing : []);
  const actives = existing.filter((r) => r.status === "active");
  type Insert = typeof corpusRules.$inferInsert;
  const inserts: Insert[] = [];
  const base = (r: Located, change: string | null, supersedesId: string | null): Insert => ({
    corpusId: id, graphId: v.graphId, ref: r.ref, section: sectionOf(r.ref), title: r.title, text: r.text, modality: r.modality, appliesTo: r.appliesTo as Record<string, unknown>,
    checkHint: r.checkHint, severity: r.severity, sourceId: r.sourceId, chunkId: r.chunkId, locator: r.locator, quote: r.quote, status: "proposed", change, supersedesId,
    corpusVersion: c.version,
  });
  if (mode === "version" && actives.length) {
    const d = diffVersion(actives, kept);
    for (const a of d.added) inserts.push(base(a, "added", null));
    for (const ch of d.changed) inserts.push(base(ch.to, "changed", ch.from.id));
    // Withdrawn from the new version: a proposal to retire the rule (it stays in force until someone approves).
    if (!state.error) for (const r of d.removed) {
      inserts.push({
        corpusId: id, graphId: v.graphId, ref: r.ref, section: r.section, title: r.title, text: r.text, modality: r.modality, appliesTo: r.appliesTo, checkHint: r.checkHint,
        severity: r.severity, sourceId: r.sourceId, chunkId: r.chunkId, locator: r.locator, quote: r.quote, status: "proposed", change: "removed", supersedesId: r.id, corpusVersion: c.version,
      });
    }
    // Drop earlier, undecided proposals for this corpus: the new reading replaces them.
    await db.update(corpusRules).set({ status: "dropped", updatedAt: new Date() }).where(and(eq(corpusRules.corpusId, id), eq(corpusRules.status, "proposed")));
  } else {
    for (const r of kept) inserts.push(base(r, mode === "version" ? "added" : null, null));
  }
  if (inserts.length) {
    const vecs = await mux.embed(inserts.map((r) => `${r.ref} ${r.title}. ${r.text}`), { userId: v.id, agent: "my-graph:corpus-reader", graphId: v.graphId });
    inserts.forEach((r, i) => { if (vecs?.[i]?.length === 1024) r.embedding = vecs[i]; });
    for (let i = 0; i < inserts.length; i += 50) await db.insert(corpusRules).values(inserts.slice(i, i + 50));
  }
  await db.update(corpusSources).set({ readAt: new Date() }).where(eq(corpusSources.corpusId, id));
  const finished: ReadState = {
    ...state, status: state.error && !found.length ? "failed" : "done", found: inserts.length, finishedAt: new Date().toISOString(),
    error: state.error ?? (failures ? `${failures} of ${limited.length} passages couldn't be read.` : work.length > MAX_PASSAGES ? `Only the first ${MAX_PASSAGES} passages were read.` : null),
  };
  await setReadState(id, finished);
  if (inserts.length) {
    await history(v, c, "corpus.rules", null, { proposed: inserts.length, mode }, "assistant");
    void logActivity({ graphId: v.graphId, userId: v.id, actor: "ingest", action: "proposed_rules", summary: `Read ${inserts.length} ${inserts.length === 1 ? "rule" : "rules"} from "${c.name}" for review`, subjectType: "corpus", subjectId: id, visibility: "household" });
  }
}

/* ── Deciding rules ─────────────────────────────────────────────────────────────────────────────────────── */

async function bump(id: string) {
  await db.update(corpora).set({ rulesVersion: sql`${corpora.rulesVersion} + 1`, updatedAt: new Date() }).where(eq(corpora.id, id));
}

/** Approve or drop proposed rules. Approving a "changed" rule retires the one it replaces; approving "removed" retires it. */
export async function decideRules(v: Viewer, corpusId: string, input: { ids: string[]; action: "approve" | "drop" }): Promise<{ decided: number }> {
  assertManage(v);
  const c = await own(v, corpusId);
  const rows = await db.select().from(corpusRules).where(and(eq(corpusRules.corpusId, corpusId), inArray(corpusRules.id, input.ids), eq(corpusRules.status, "proposed")));
  if (!rows.length) return { decided: 0 };
  const now = new Date();
  await db.transaction(async (tx) => {
    for (const r of rows) {
      if (input.action === "drop") {
        await tx.update(corpusRules).set({ status: "dropped", decidedBy: v.id, decidedAt: now, updatedAt: now }).where(eq(corpusRules.id, r.id));
        continue;
      }
      if (r.change === "removed") {
        if (r.supersedesId) await tx.update(corpusRules).set({ status: "retired", decidedBy: v.id, decidedAt: now, updatedAt: now }).where(and(eq(corpusRules.id, r.supersedesId), eq(corpusRules.corpusId, corpusId)));
        await tx.update(corpusRules).set({ status: "retired", decidedBy: v.id, decidedAt: now, updatedAt: now }).where(eq(corpusRules.id, r.id));
        continue;
      }
      if (r.change === "changed" && r.supersedesId) {
        await tx.update(corpusRules).set({ status: "retired", decidedBy: v.id, decidedAt: now, updatedAt: now }).where(and(eq(corpusRules.id, r.supersedesId), eq(corpusRules.corpusId, corpusId)));
      }
      await tx.update(corpusRules).set({ status: "active", decidedBy: v.id, decidedAt: now, updatedAt: now }).where(eq(corpusRules.id, r.id));
    }
  });
  if (input.action === "approve") {
    await bump(corpusId);
    // A corpus with approved rules is in use: a draft becomes active the first time.
    if (c.status === "draft") await db.update(corpora).set({ status: "active" }).where(eq(corpora.id, corpusId));
  }
  const refs = rows.map((r) => r.ref).slice(0, 12);
  await history(v, c, input.action === "approve" ? "corpus.rules.approved" : "corpus.rules.dropped", null, { count: rows.length, refs });
  void logActivity({
    graphId: v.graphId, userId: v.id, actor: "wiki", action: input.action === "approve" ? "approved_rules" : "dropped_rules",
    summary: `${input.action === "approve" ? "Approved" : "Dropped"} ${rows.length} ${rows.length === 1 ? "rule" : "rules"} in "${c.name}"`, subjectType: "corpus", subjectId: corpusId, visibility: "household",
  });
  return { decided: rows.length };
}

export type RulePatch = { ref?: string; title?: string; text?: string; modality?: Modality; severity?: Severity; checkHint?: string | null; appliesTo?: CorpusScope; status?: "active" | "retired" };

export async function editRule(v: Viewer, corpusId: string, ruleId: string, patch: RulePatch): Promise<void> {
  assertManage(v);
  const c = await own(v, corpusId);
  const [r] = await db.select().from(corpusRules).where(and(eq(corpusRules.id, ruleId), eq(corpusRules.corpusId, corpusId), eq(corpusRules.graphId, v.graphId))).limit(1);
  if (!r) throw new CorpusError(404, "That rule isn't here.");
  const set: Partial<typeof corpusRules.$inferInsert> = { updatedAt: new Date() };
  if (patch.ref !== undefined) { set.ref = patch.ref.trim() || r.ref; set.section = sectionOf(set.ref); }
  if (patch.title !== undefined) set.title = patch.title.trim() || r.title;
  if (patch.text !== undefined) set.text = patch.text.trim() || r.text;
  if (patch.modality) set.modality = patch.modality;
  if (patch.severity) set.severity = patch.severity;
  if (patch.checkHint !== undefined) set.checkHint = patch.checkHint?.trim() || null;
  if (patch.appliesTo) set.appliesTo = patch.appliesTo as Record<string, unknown>;
  if (patch.status && (r.status === "active" || r.status === "retired")) { set.status = patch.status; set.decidedBy = v.id; set.decidedAt = new Date(); }
  if (set.text || set.title || set.ref) {
    const vec = await mux.embed([`${set.ref ?? r.ref} ${set.title ?? r.title}. ${set.text ?? r.text}`], { userId: v.id, agent: "my-graph:corpus-reader", graphId: v.graphId });
    if (vec?.[0]?.length === 1024) set.embedding = vec[0];
  }
  await db.update(corpusRules).set(set).where(eq(corpusRules.id, ruleId));
  if (r.status === "active" || set.status) await bump(corpusId);
  const changed = Object.keys(patch).filter((k) => (patch as Record<string, unknown>)[k] !== undefined);
  await history(v, c, `corpus.rule.${r.ref}`, { text: r.text, modality: r.modality, status: r.status }, { ...(set.text ? { text: set.text } : {}), ...(set.modality ? { modality: set.modality } : {}), ...(set.status ? { status: set.status } : {}), fields: changed });
}

/** A rule a person writes in by hand (with its quote if they have one). Active at once: a person wrote it. */
export async function addRule(v: Viewer, corpusId: string, input: { ref: string; title?: string; text: string; modality: Modality; severity?: Severity; checkHint?: string | null; quote?: string | null }): Promise<string> {
  assertManage(v);
  const c = await own(v, corpusId);
  const vec = await mux.embed([`${input.ref} ${input.title ?? ""}. ${input.text}`], { userId: v.id, agent: "my-graph:corpus-reader", graphId: v.graphId });
  const [row] = await db.insert(corpusRules).values({
    corpusId, graphId: v.graphId, ref: input.ref.trim(), section: sectionOf(input.ref), title: (input.title?.trim() || input.text).slice(0, 120), text: input.text.trim(),
    modality: input.modality, severity: input.severity ?? defaultSeverity(input.modality, c.binding as Binding), checkHint: input.checkHint ?? null, quote: input.quote ?? null,
    status: "active", decidedBy: v.id, decidedAt: new Date(), corpusVersion: c.version, ...(vec?.[0]?.length === 1024 ? { embedding: vec[0] } : {}),
  }).returning({ id: corpusRules.id });
  await bump(corpusId);
  if (c.status === "draft") await db.update(corpora).set({ status: "active" }).where(eq(corpora.id, corpusId));
  await history(v, c, `corpus.rule.${input.ref}`, null, { text: input.text, modality: input.modality, status: "active" });
  return row.id;
}

/* ── For checks and the assistant ───────────────────────────────────────────────────────────────────────── */

export type ActiveRule = {
  id: string; corpusId: string; corpusName: string; ref: string; title: string; text: string; modality: string; severity: string;
  checkHint: string | null; quote: string | null; appliesTo: CorpusScope; sourceId: string | null; locator: Record<string, unknown>; score: number;
};

/** Active rules of these corpora, closest first to `vector` when one is given (cosine similarity, 0..1). */
export async function activeRules(v: Viewer, corpusIds: string[], vector: number[] | null): Promise<ActiveRule[]> {
  if (!corpusIds.length) return [];
  const score = vector ? sql<number>`case when ${corpusRules.embedding} is null then 0.3 else 1 - (${corpusRules.embedding} <=> ${JSON.stringify(vector)}::vector) end` : sql<number>`0.5`;
  const rows = await db.select({
    id: corpusRules.id, corpusId: corpusRules.corpusId, corpusName: corpora.name, ref: corpusRules.ref, title: corpusRules.title, text: corpusRules.text,
    modality: corpusRules.modality, severity: corpusRules.severity, checkHint: corpusRules.checkHint, quote: corpusRules.quote, appliesTo: corpusRules.appliesTo,
    sourceId: corpusRules.sourceId, locator: corpusRules.locator, score,
  }).from(corpusRules).innerJoin(corpora, eq(corpora.id, corpusRules.corpusId))
    .where(and(inArray(corpusRules.corpusId, corpusIds), eq(corpusRules.graphId, v.graphId), eq(corpora.graphId, v.graphId), eq(corpusRules.status, "active")))
    .limit(400);
  return rows.map((r) => ({ ...r, score: Number(r.score), appliesTo: readScope(r.appliesTo), locator: (r.locator ?? {}) as Record<string, unknown> }))
    .sort((a, b) => b.score - a.score);
}

/** Search rules across the graph's corpora (the corpus page's search and the assistant's retrieval). */
export async function searchRules(v: Viewer, q: string, opts: { limit?: number; corpusIds?: string[] } = {}): Promise<ActiveRule[]> {
  const ids = opts.corpusIds ?? (await db.select({ id: corpora.id }).from(corpora).where(and(eq(corpora.graphId, v.graphId), ne(corpora.status, "retired")))).map((r) => r.id);
  if (!ids.length || !q.trim()) return [];
  const vec = (await mux.embed([q.slice(0, 2000)], { userId: v.id, agent: "my-graph:corpus-search", graphId: v.graphId }))?.[0] ?? null;
  const rules = await activeRules(v, ids, vec);
  const words = q.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  const kw = (r: ActiveRule) => words.filter((w) => `${r.ref} ${r.title} ${r.text} ${r.corpusName}`.toLowerCase().includes(w)).length / Math.max(1, words.length);
  return rules.map((r) => ({ ...r, score: vec ? r.score + kw(r) * 0.2 : kw(r) }))
    .filter((r) => (vec ? r.score > 0.35 : r.score > 0))
    .sort((a, b) => b.score - a.score).slice(0, opts.limit ?? 8);
}

/** Corpus names mentioned in a question ("Does this comply with BEK 260?"). */
export async function corporaNamed(v: Viewer, text: string): Promise<{ id: string; name: string }[]> {
  const rows = await db.select({ id: corpora.id, name: corpora.name, version: corpora.version }).from(corpora).where(and(eq(corpora.graphId, v.graphId), ne(corpora.status, "retired")));
  const t = text.toLowerCase();
  return rows.filter((r) => {
    const n = r.name.toLowerCase();
    if (t.includes(n)) return true;
    const head = n.match(/^[a-zæøå]+\s?\d+/)?.[0];
    return !!head && t.replace(/\s+/g, " ").includes(head);
  });
}
