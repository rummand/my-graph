/**
 * Live highlights, server side: the viewer's lexicon and the per-sentence model tier.
 *
 * `loadLexicon` reads every node the viewer may read in the current graph (id, label, aliases, type, kind) once per
 * graph version (a cheap stamp: node count, last node change, last graph event, the viewer's shares) and keeps it
 * with its matcher and the graph's meta model in memory. `readSentence` reads ONE sentence with the fast model,
 * giving it only the graph names in that sentence as context, and caches the answer per (viewer, graph, lexicon
 * version, sentence) so a sentence is never read twice. `readFacts` is the cheap whole-text pass for facts that span
 * sentences. Nothing here writes: Send is still the person's decision (commitAnnotations).
 */
import { and, eq, isNull, notInArray, desc, sql } from "drizzle-orm";
import type { Viewer } from "@/lib/auth";
import { db } from "@/db";
import { nodes } from "@/db/schema";
import { accessContext } from "@/lib/gbrain";
import { liveNodeSql, nodeReadSql } from "@/lib/gbrain/access";
import { scopeOf } from "@/lib/graphs/pure";
import { isMuxDown } from "@/lib/mux";
import { getMeta, type Meta } from "@/lib/meta";
import { planFromExtraction, type DomainPlan, type KnownNode } from "@/lib/meta/domain";
import { canDecideModel } from "@/lib/meta/emergent";
import { extractDomain } from "@/lib/meta/suggest";
import { normalizeTerm } from "@/lib/meta/synonyms";
import { locateSpans } from "../markup";
import { detectDetails, type Detail } from "./detect";
import { keepNamedThings } from "./entities";
import { buildMatcher, type LexEntry, type LexMatch, type Matcher } from "./matcher";
import { newRef, nodeRef, type FactsResult, type SentenceEntity, type SentenceResult } from "./merge";
import { hash53, Lru, sentenceKey } from "./sentences";

const MAX_ENTRIES = 20000;

export type Lexicon = {
  version: string;
  entries: LexEntry[];
  matcher: Matcher;
  byName: Map<string, LexEntry[]>;
  meta: Meta;
  selfId: string | null;
  selfLabel: string;
};

type Caches = {
  lex: Lru<string, Lexicon>;
  sentences: Lru<string, SentenceResult>;
  facts: Lru<string, FactsResult>;
  inflight: Map<string, Promise<SentenceResult>>;
  running: Map<string, number>;
};
const g = globalThis as unknown as { __mgLive?: Caches };
const caches: Caches = (g.__mgLive ??= {
  lex: new Lru(200), sentences: new Lru(4000), facts: new Lru(500), inflight: new Map(), running: new Map(),
});

const lexKey = (v: Viewer) => `${v.id}:${v.graphId}:${v.role}:${v.graphRole}`;

/** A cheap stamp that changes whenever what the viewer can name in this graph may have changed. */
export async function lexiconStamp(v: Viewer): Promise<string> {
  const r = await db.execute<{ n: string; u: string | null; e: string | null; s: string }>(sql`select
    (select count(*) from nodes where graph_id = ${v.graphId})::text as n,
    (select max(updated_at) from nodes where graph_id = ${v.graphId})::text as u,
    (select max(at) from graph_events where graph_id = ${v.graphId})::text as e,
    (select count(*)::text || '/' || coalesce(max(created_at)::text, '') from shares where user_id = ${v.id}) as s`);
  const row = r[0] ?? { n: "", u: "", e: "", s: "" };
  return hash53(`${lexKey(v)}|${row.n}|${row.u}|${row.e}|${row.s}`);
}

/** The ETag of the viewer's lexicon (it names the viewer and the graph, so a copy never crosses either). */
export const lexiconEtag = (v: Viewer, stamp: string) => `W/"lx-${hash53(`${v.id}:${v.graphId}:${stamp}`)}"`;

/** The viewer's lexicon for the current graph, rebuilt only when the stamp moved. */
export async function loadLexicon(v: Viewer, stamp?: string): Promise<Lexicon> {
  const version = stamp ?? await lexiconStamp(v);
  const key = lexKey(v);
  const have = caches.lex.get(key);
  if (have?.version === version) return have;
  const ctx = await accessContext(v);
  const [rows, meta] = await Promise.all([
    db.select({ id: nodes.id, label: nodes.label, aliases: nodes.aliases, type: nodes.type, kind: nodes.kind, sensitive: nodes.sensitive })
      .from(nodes)
      .where(and(isNull(nodes.mergedInto), nodeReadSql(ctx, "nodes"), liveNodeSql("nodes"), notInArray(nodes.type, ["source", "document"]), eq(nodes.graphId, v.graphId)))
      .orderBy(desc(nodes.updatedAt)).limit(MAX_ENTRIES),
    getMeta(v),
  ]);
  // People first, then everything else by recency: when two things share a name, the first one wins.
  const rank = (t: string) => (t === "person" ? 0 : t === "organization" ? 1 : t === "place" ? 2 : 3);
  const entries: LexEntry[] = rows.map((r) => ({
    id: r.id, label: r.label, aliases: r.aliases?.length ? r.aliases : undefined, type: r.type, kind: r.kind ?? null,
    kindLabel: r.kind ? meta.kind(r.type, r.kind)?.label ?? null : null,
    self: r.id === v.personNodeId || undefined, sensitive: r.sensitive || undefined,
  })).map((e, i) => ({ e, i })).sort((a, b) => rank(a.e.type) - rank(b.e.type) || a.i - b.i).map((x) => x.e);
  const byName = new Map<string, LexEntry[]>();
  for (const e of entries) for (const n of [e.label, ...(e.aliases ?? [])]) {
    const k = normalizeTerm(n);
    if (!k) continue;
    const list = byName.get(k);
    if (list) list.push(e); else byName.set(k, [e]);
  }
  const self = entries.find((e) => e.self);
  const lex: Lexicon = { version, entries, matcher: buildMatcher(entries), byName, meta, selfId: v.personNodeId, selfLabel: self?.label ?? v.name };
  caches.lex.set(key, lex);
  return lex;
}

/** What GET /api/annotate/lexicon sends: compact entries plus what the composer needs to know about the viewer. */
export function lexiconPayload(v: Viewer, lex: Lexicon) {
  return {
    version: lex.version,
    graphId: v.graphId,
    readOnly: !scopeOf(v).canWrite,
    canGrowModel: canDecideModel(v),
    selfLabel: lex.selfLabel,
    entries: lex.entries.map((e) => ({
      i: e.id, l: e.label, t: e.type,
      ...(e.aliases ? { a: e.aliases } : {}), ...(e.kind ? { k: e.kind } : {}), ...(e.kindLabel ? { kl: e.kindLabel } : {}),
      ...(e.self ? { me: 1 } : {}), ...(e.sensitive ? { s: 1 } : {}),
    })),
  };
}
export type LexiconPayload = ReturnType<typeof lexiconPayload>;

/* ── Per-sentence model tier ─────────────────────────────────────────────────────────────────────────── */

const known = (e: LexEntry): KnownNode => ({ id: e.id, label: e.label, aliases: e.aliases, type: e.type, kind: e.kind ?? null });
const uniqEntries = (xs: LexEntry[]) => xs.filter((e, i) => xs.findIndex((x) => x.id === e.id) === i);

/**
 * One model per person per graph for the live tier: every sentence's prompt starts with the same instructions, name and
 * meta model, which stay in that model's prompt cache (only the sentence and the names in it are new).
 */
const liveAffinity = (v: Viewer) => `live:${v.id}:${v.graphId}`;

/** At most a few model calls at once per person; the rest wait their turn (typing fast never floods mux). */
async function withSlot<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  while ((caches.running.get(userId) ?? 0) >= 4) await new Promise((r) => setTimeout(r, 40));
  caches.running.set(userId, (caches.running.get(userId) ?? 0) + 1);
  try { return await fn(); } finally { caches.running.set(userId, (caches.running.get(userId) ?? 1) - 1); }
}

/** Map a plan onto stable refs, with entity positions inside `text`. Entities whose words aren't found are left out. */
export function toSentenceResult(key: string, text: string, plan: DomainPlan, selfId: string | null): SentenceResult {
  const refOf = new Map<string, string>([["you", "you"]]);
  const entities: SentenceEntity[] = [];
  const located = locateSpans(text, plan.entities.map((e) => ({ ref: e.ref, surface: e.surface, alternatives: [e.label] })));
  for (const e of plan.entities) {
    if (e.nodeId && e.nodeId === selfId) { refOf.set(e.ref, "you"); continue; }
    const ref = e.nodeId ? nodeRef(e.nodeId) : newRef(e.label);
    refOf.set(e.ref, ref);
    const at = located.find((s) => s.ref === e.ref);
    if (!at) continue;
    entities.push({ ...e, ref, at: at.start, len: at.end - at.start });
  }
  const facts = plan.facts.flatMap((f) => {
    const from = refOf.get(f.from), to = refOf.get(f.to);
    return from && to && from !== to ? [{ ...f, from, to }] : [];
  });
  return { key, text, entities, facts, kinds: plan.kinds, relations: plan.relations };
}

/** Lexicon entries the model's labels may mean (by name or alias), plus the ones the matcher found. */
function knownFor(lex: Lexicon, labels: string[], matches: LexMatch[]): KnownNode[] {
  const fromLabels = labels.flatMap((l) => lex.byName.get(normalizeTerm(l)) ?? []);
  return uniqEntries([...matches.map((m) => m.entry), ...fromLabels]).filter((e) => !e.self).map(known);
}

async function computeSentence(v: Viewer, lex: Lexicon, key: string, text: string, sensitive: boolean): Promise<SentenceResult> {
  const matches = lex.matcher.match(text);
  const self = lex.entries.find((e) => e.self);
  const context = uniqEntries([...matches.map((m) => m.entry), ...(self ? [self] : [])]).slice(0, 30).map(known);
  const raw = await withSlot(v.id, () => extractDomain(v, text, { route: "fast", meta: lex.meta, known: context, mode: "live", agent: "my-graph-live-highlights", sensitive, affinity: liveAffinity(v) }));
  // Named things only: dates, amounts and common words the model marked anyway are left to the detectors.
  const x = keepNamedThings(text, raw, new Set(context.map((k) => k.id))).kept;
  const plan = planFromExtraction(lex.meta, x, knownFor(lex, x.entities.map((e) => e.label), matches), { id: lex.selfId, label: lex.selfLabel }, { text });
  return toSentenceResult(key, text, plan, lex.selfId);
}

export type LiveEvent =
  | { t: "det"; key: string; details: Detail[]; links: { start: number; end: number; nodeId: string; label: string; type: string }[] }
  | { t: "model"; key: string; result: SentenceResult; cached: boolean; ms: number }
  | { t: "muxDown"; key: string }
  | { t: "error"; key: string; error: string }
  | { t: "skip"; key: string; reason: "readOnly" | "short" };

/** One sentence through the model tier, cached. Throws MuxError when mux is down. */
export async function readSentence(v: Viewer, lex: Lexicon, text: string, sensitive: boolean): Promise<{ result: SentenceResult; cached: boolean }> {
  const key = sentenceKey(text);
  const ck = `${lexKey(v)}:${lex.version}:${sensitive ? 1 : 0}:${key}`;
  const hit = caches.sentences.get(ck);
  if (hit) return { result: { ...hit, text }, cached: true };
  let p = caches.inflight.get(ck);
  if (!p) {
    // Not tied to the request: if the person retypes or undoes, the answer is already on its way into the cache.
    p = computeSentence(v, lex, key, text, sensitive)
      .then((r) => { caches.sentences.set(ck, r); return r; })
      .finally(() => caches.inflight.delete(ck));
    caches.inflight.set(ck, p);
  }
  return { result: await p, cached: false };
}

/**
 * Events for some sentences, as soon as each part is ready: the deterministic findings for every sentence first,
 * then each sentence's model answer in whatever order they finish.
 */
export async function* streamSentences(v: Viewer, input: { sentences: { key?: string; text: string }[]; sensitive?: boolean }, stamp?: string): AsyncGenerator<LiveEvent> {
  const lex = await loadLexicon(v, stamp);
  const items = input.sentences.map((s) => ({ key: s.key ?? sentenceKey(s.text), text: s.text }));
  for (const s of items) {
    const links = lex.matcher.match(s.text).filter((m) => !m.entry.self).map((m) => ({ start: m.start, end: m.end, nodeId: m.entry.id, label: m.entry.label, type: m.entry.type }));
    yield { t: "det", key: s.key, details: detectDetails(s.text), links };
  }
  if (!scopeOf(v).canWrite) { for (const s of items) yield { t: "skip", key: s.key, reason: "readOnly" }; return; }
  const queue: LiveEvent[] = [];
  let wake: (() => void) | null = null;
  let left = 0;
  for (const s of items) {
    if (s.text.trim().length < 6 || !/\p{L}{2}/u.test(s.text)) { queue.push({ t: "skip", key: s.key, reason: "short" }); continue; }
    left++;
    const t0 = Date.now();
    void readSentence(v, lex, s.text, !!input.sensitive)
      .then(({ result, cached }) => queue.push({ t: "model", key: s.key, result: { ...result, key: s.key }, cached, ms: Date.now() - t0 }))
      .catch((e) => {
        if (isMuxDown(e)) queue.push({ t: "muxDown", key: s.key });
        else { console.error("[live highlights]", e); queue.push({ t: "error", key: s.key, error: "This sentence couldn't be read." }); }
      })
      .finally(() => { left--; wake?.(); });
  }
  while (true) {
    while (queue.length) yield queue.shift()!;
    if (left <= 0) break;
    await new Promise<void>((r) => { wake = r; });
    wake = null;
  }
  while (queue.length) yield queue.shift()!;
}

/* ── Whole-text facts pass ───────────────────────────────────────────────────────────────────────────── */

export type FactsEntity = { ref: string; label: string; type: string; nodeId: string | null };

/**
 * Facts that span sentences ("Peter joins us. He works at Novo."): one cheap read of the whole text, keeping only
 * facts between things the composer already shows (by node id or name) and "you".
 */
export async function readFacts(v: Viewer, input: { text: string; entities: FactsEntity[]; sensitive?: boolean }): Promise<FactsResult> {
  if (!scopeOf(v).canWrite || input.entities.length === 0) return { facts: [], relations: [] };
  const lex = await loadLexicon(v);
  const ck = `${lexKey(v)}:${lex.version}:${input.sensitive ? 1 : 0}:${hash53(input.text)}:${hash53(input.entities.map((e) => e.ref).sort().join(","))}`;
  const hit = caches.facts.get(ck);
  if (hit) return hit;
  const ids = new Set(lex.entries.map((e) => e.id));
  const given = input.entities.filter((e) => !e.nodeId || ids.has(e.nodeId));
  const knownNodes = given.flatMap((e) => (e.nodeId ? [lex.entries.find((x) => x.id === e.nodeId)!] : [])).map(known);
  const self = lex.entries.find((e) => e.self);
  const x = await withSlot(v.id, () => extractDomain(v, input.text, {
    route: "fast", meta: lex.meta, known: [...knownNodes, ...(self ? [known(self)] : [])], mode: "live", agent: "my-graph-live-facts", sensitive: input.sensitive,
    affinity: liveAffinity(v),
  }));
  const plan = planFromExtraction(lex.meta, x, knownNodes, { id: lex.selfId, label: lex.selfLabel }, { text: input.text });
  // The model's refs → the composer's refs.
  const byNorm = new Map(given.map((e) => [normalizeTerm(e.label), e.ref]));
  const refOf = new Map<string, string>([["you", "you"]]);
  for (const e of plan.entities) {
    const r = e.nodeId && e.nodeId === lex.selfId ? "you"
      : e.nodeId && given.some((g) => g.nodeId === e.nodeId) ? nodeRef(e.nodeId)
      : byNorm.get(normalizeTerm(e.label)) ?? byNorm.get(normalizeTerm(e.surface));
    if (r) refOf.set(e.ref, r);
  }
  const facts = plan.facts.flatMap((f) => {
    const from = refOf.get(f.from), to = refOf.get(f.to);
    return from && to && from !== to ? [{ ...f, from, to }] : [];
  });
  const out: FactsResult = { facts, relations: plan.relations.filter((r) => facts.some((f) => f.relationKey === r.key)) };
  caches.facts.set(ck, out);
  return out;
}
