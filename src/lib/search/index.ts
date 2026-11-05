/**
 * Search across the current graph: people and things, pages/documents/decks, library files (titles and passages),
 * rules, the viewer's own conversations, change sets waiting, and timeline events. Server-only.
 *
 * Access: every section reads through its owning library's rules (GBrain's nodeReadSql/edgeSelfReadSql,
 * sourceVisibleTo, pageReadSql, canSeeArtifact, the change sets' visibleSql, conversations are the viewer's own) and
 * is pinned to the viewer's current graph. Someone else's sensitive item may be found by name, never by its words.
 *
 * Ranking: name tiers > alias > full-text ('simple' tsvector, prefix-matched, with ILIKE for words inside compounds)
 * > meaning (pgvector over existing node/chunk embeddings, full mode only, skipped when mux is down or slow).
 * Sections run in parallel; each is capped.
 */
import { and, desc, eq, inArray, isNotNull, isNull, ne, notInArray, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/db";
import { artifacts, changeSets, chunks, conversations, corpora, corpusRules, edges, messages, nodes, sources, users, wikiPages } from "@/db/schema";
import type { Viewer } from "@/lib/auth";
import { accessContext } from "@/lib/gbrain";
import { edgeSelfReadSql, liveNodeSql, nodeReadSql, type AccessCtx } from "@/lib/gbrain/access";
import { sourceVisibleTo } from "@/lib/ingest/access";
import { pageReadSql } from "@/lib/pages/access";
import { canSeeArtifact } from "@/lib/artifacts/content";
import { madeHref, madeKindOf } from "@/lib/artifacts/kinds";
import { visibleSql as changeSetVisibleSql } from "@/lib/changes/store";
import { localizeTitle } from "@/lib/changes/titles";
import { scopeOf } from "@/lib/graphs/pure";
import { getLocale, getT, type TFn } from "@/lib/i18n";
import { getMeta, roleKeyOf, roleText } from "@/lib/meta";
import { kindName } from "@/lib/people/words";
import { embed } from "@/lib/mux";
import { sectionsFor, snippetAllowed } from "./access";
import { findRanges, jsonText, makeSnippet } from "./highlight";
import { likePattern, parseQuery, prefixTsQuery, refRegex, searchable, textTerms, wordStartRegex, type ParsedQuery } from "./query";
import { labelScore, meaningScore, mergeHits, nudge, pickTop, sortHits, textScore, TIER, type SortOrder } from "./rank";
import { SECTIONS, type Hit, type HitKind, type SearchMode, type SearchResponse, type Section, type SectionResult } from "./types";

export type SearchInput = {
  q: string;
  types?: Section[];
  mode?: SearchMode;
  /** Per section (quick mode uses its own caps). */
  limit?: number;
  offset?: number;
  owner?: "me" | "others" | null;
  from?: Date | null;
  to?: Date | null;
  /** Library only: files in this folder. */
  folder?: string | null;
  sort?: SortOrder;
};

const QUICK_CAPS: Record<Section, number> = { nodes: 6, made: 4, files: 5, rules: 4, chats: 3, changes: 3, events: 3 };
/** Cosine similarity (bge-m3) a meaning-only result needs; below it results read as noise. At most 3 per section. */
const MEANING_MIN = 0.62;
const LIBRARY_KINDS = ["upload", "manual", "sync", "email", "web", "connector"] as const;
const NODE_SECTION_EXCLUDE = ["event", "document", "source"] as const;

type Ctx = {
  v: Viewer; ctx: AccessCtx; p: ParsedQuery; terms: string[]; needles: string[]; t: TFn; locale: string;
  mode: SearchMode; cap: number; offset: number; input: SearchInput; parent: boolean;
};

/* ── SQL helpers ─────────────────────────────────────────────────────────────────────────────────────── */

/**
 * Every term in `col` (and every quoted phrase). Words of 4+ letters may sit inside a longer word ("læge" in
 * "tandlæge"); shorter ones must start a word, so "ny" finds "ny side" but not "any" or "pseudonym".
 */
function allLike(col: SQL, c: Ctx): SQL | undefined {
  const parts = [
    ...c.terms.map((t) => t.length >= 4 ? sql`${col} ilike ${likePattern(t)}` : sql`${col} ~* ${wordStartRegex(t)}`),
    ...c.p.phrases.map((t) => sql`${col} ilike ${likePattern(t)}`),
  ];
  if (c.p.ref) parts.push(sql`${col} ~* ${refRegex(c.p.ref)}`);
  return parts.length ? and(...parts) : undefined;
}

function tsq(c: Ctx): string | null {
  return prefixTsQuery(c.terms);
}

function dateRange(col: SQL, c: Ctx): SQL | undefined {
  return and(c.input.from ? sql`${col} >= ${c.input.from}` : undefined, c.input.to ? sql`${col} < ${c.input.to}` : undefined);
}

function ownerCond(col: SQL, c: Ctx): SQL | undefined {
  if (c.input.owner === "me") return sql`${col} = ${c.v.id}`;
  if (c.input.owner === "others") return sql`${col} <> ${c.v.id}`;
  return undefined;
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const clip = (s: string | null | undefined, n: number) => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};

function fetchN(c: Ctx): number {
  return Math.min(200, (c.cap + c.offset) * 3 + 6);
}

function finish(hits: Hit[], c: Ctx): { items: Hit[]; more: boolean } {
  const now = Date.now();
  const scored = hits.map((h) => ({ ...h, score: Math.min(100, Math.round((h.score + nudge(h, now)) * 10) / 10) }));
  const sorted = sortHits(scored, c.input.sort ?? "relevance");
  return { items: sorted.slice(c.offset, c.offset + c.cap), more: sorted.length > c.offset + c.cap };
}

/* ── Sections ────────────────────────────────────────────────────────────────────────────────────────── */

type NodeRow = { id: string; type: string; kind: string | null; label: string; aliases: string[] | null; summary: string | null; ownerId: string; sensitive: boolean; startAt: Date | null; updatedAt: Date; rank: number };

async function nodeRows(c: Ctx, where: SQL | undefined): Promise<NodeRow[]> {
  const q = tsq(c);
  const nameCond = allLike(sql`(${nodes.label} || ' ' || array_to_string(${nodes.aliases}, ' '))`, c);
  const textCond = q ? sql`${nodes.search} @@ to_tsquery('simple', ${q})` : undefined;
  const match = or(nameCond, c.p.ref ? undefined : textCond);
  if (!match) return [];
  const rank = q ? sql<number>`ts_rank(coalesce(${nodes.search}, ''::tsvector), to_tsquery('simple', ${q}))` : sql<number>`0`;
  const lower = c.p.text.toLowerCase();
  return db.select({
    id: nodes.id, type: nodes.type, kind: nodes.kind, label: nodes.label, aliases: nodes.aliases, summary: nodes.summary,
    ownerId: nodes.ownerId, sensitive: nodes.sensitive, startAt: nodes.startAt, updatedAt: nodes.updatedAt, rank,
  }).from(nodes)
    .where(and(isNull(nodes.mergedInto), nodeReadSql(c.ctx, "nodes"), liveNodeSql("nodes"), where, match,
      ownerCond(sql`${nodes.ownerId}`, c), dateRange(sql`coalesce(${nodes.startAt}, ${nodes.updatedAt})`, c)))
    .orderBy(sql`case when lower(${nodes.label}) = ${lower} then 0 when lower(${nodes.label}) like ${`${lower.replace(/[\\%_]/g, (x) => `\\${x}`)}%`} then 1 else 2 end`, desc(rank), desc(nodes.updatedAt))
    .limit(fetchN(c));
}

function nodeHit(c: Ctx, r: NodeRow, section: Section): Hit {
  const ls = labelScore(r.label, r.aliases, c.p.text, c.terms);
  const kind: HitKind = (["person", "place", "organization", "event", "topic", "project"] as const).includes(r.type as never) ? (r.type as HitKind) : "thing";
  const showText = snippetAllowed(c.v, r);
  const sumRanges = r.summary && showText ? findRanges(r.summary, c.needles) : [];
  return {
    key: `node:${r.id}`, section, kind, id: r.id, title: r.label,
    href: r.type === "person" ? `/people/${r.id}` : `/node/${r.id}`,
    titleRanges: findRanges(r.label, c.needles), context: [],
    snippet: !ls && showText && r.summary ? makeSnippet(r.summary, c.needles, 120) : null,
    sub: r.kind, colorId: r.type === "person" ? r.id : null,
    date: iso(r.type === "event" ? r.startAt : r.updatedAt), sensitive: !showText,
    score: ls ? ls.score : textScore(r.rank) - (sumRanges.length ? 0 : 4),
    via: ls ? ls.via : "text",
  } satisfies Hit;
}

/** "Teacher at Vejle Skole" for people found, from their role facts the viewer may see. */
async function personRoles(c: Ctx, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!ids.length) return out;
  const t = alias(nodes, "rt");
  const rows = await db.select({ fromId: edges.fromId, relation: edges.relation, toId: edges.toId, toLabel: t.label, toType: t.type })
    .from(edges).innerJoin(t, eq(t.id, edges.toId))
    .where(and(inArray(edges.fromId, ids), sql`${edges.relation} like 'role:%'`, notInArray(edges.status, ["rejected", "superseded"]),
      edgeSelfReadSql(c.ctx, "edges"), nodeReadSql(c.ctx, "rt"), isNull(t.mergedInto)))
    .orderBy(desc(edges.confidence)).limit(ids.length * 3);
  if (!rows.length) return out;
  const meta = await getMeta(c.v);
  for (const r of rows) {
    if (out.has(r.fromId)) continue;
    const key = roleKeyOf(r.relation);
    if (!key) continue;
    out.set(r.fromId, roleText(meta.role(key), key, r.toId === r.fromId ? null : { label: r.toLabel, type: r.toType }, c.locale));
  }
  return out;
}

async function kindLabels(c: Ctx, rows: { type: string; kind: string | null }[]): Promise<(type: string, kind: string | null) => string> {
  const typeWord = (type: string) => c.t(`search.types.${type}`, undefined, type);
  if (!rows.some((r) => r.kind)) return typeWord;
  const meta = await getMeta(c.v).catch(() => null);
  return (type, kind) => {
    const k = kind && meta ? meta.kind(type, kind) : undefined;
    return k ? kindName(c.t, k.label) : typeWord(type);
  };
}

async function nodesSection(c: Ctx, section: "nodes" | "events", semantic: number[] | null): Promise<{ items: Hit[]; more: boolean }> {
  const typeCond = section === "events"
    ? eq(nodes.type, "event")
    : c.p.filter?.nodeTypes?.length ? inArray(nodes.type, c.p.filter.nodeTypes) : notInArray(nodes.type, [...NODE_SECTION_EXCLUDE]);
  const [rows, sem] = await Promise.all([
    nodeRows(c, typeCond),
    semantic ? db.select({
      id: nodes.id, type: nodes.type, kind: nodes.kind, label: nodes.label, aliases: nodes.aliases, summary: nodes.summary,
      ownerId: nodes.ownerId, sensitive: nodes.sensitive, startAt: nodes.startAt, updatedAt: nodes.updatedAt,
      rank: sql<number>`1 - (${nodes.embedding} <=> ${JSON.stringify(semantic)}::vector)`,
    }).from(nodes).where(and(isNull(nodes.mergedInto), nodeReadSql(c.ctx, "nodes"), liveNodeSql("nodes"), typeCond, isNotNull(nodes.embedding),
      ownerCond(sql`${nodes.ownerId}`, c), dateRange(sql`coalesce(${nodes.startAt}, ${nodes.updatedAt})`, c)))
      .orderBy(sql`${nodes.embedding} <=> ${JSON.stringify(semantic)}::vector`).limit(8) : Promise.resolve([] as NodeRow[]),
  ]);
  // Someone else's sensitive node is found by its name only, never by the words of its summary or by meaning.
  const kw = rows.map((r) => nodeHit(c, r, section)).filter((h) => !(h.sensitive && h.via === "text"));
  const mean = sem.filter((r) => Number(r.rank) > MEANING_MIN && snippetAllowed(c.v, r)).slice(0, 3).map((r) => ({ ...nodeHit(c, r, section), score: meaningScore(Number(r.rank)), via: "meaning" as const, snippet: null }));
  const { items, more } = finish(mergeHits([kw, mean]), c);
  const all = [...rows, ...sem];
  const [roles, kindOf] = await Promise.all([
    personRoles(c, items.filter((h) => h.kind === "person").map((h) => h.id)).catch(() => new Map<string, string>()),
    kindLabels(c, all),
  ]);
  const byId = new Map(all.map((r) => [r.id, r]));
  for (const h of items) {
    const r = byId.get(h.id)!;
    const role = roles.get(h.id);
    const summary = snippetAllowed(c.v, r) ? clip(r.summary, 70) : "";
    h.context = [kindOf(r.type, r.kind), role ?? (h.snippet ? "" : summary)].filter(Boolean);
  }
  return { items, more };
}

async function filesSection(c: Ctx, semantic: number[] | null): Promise<{ items: Hit[]; more: boolean }> {
  const base = and(sourceVisibleTo(c.v), inArray(sources.kind, [...LIBRARY_KINDS]), isNull(sources.supersededAt),
    ownerCond(sql`${sources.ownerId}`, c), dateRange(sql`coalesce(${sources.documentDate}, ${sources.createdAt})`, c),
    c.input.folder ? eq(sources.folderId, c.input.folder) : undefined);
  const q = tsq(c);
  const srcCols = {
    id: sources.id, title: sources.title, mime: sources.mime, ownerId: sources.ownerId, sensitive: sources.sensitive,
    documentDate: sources.documentDate, createdAt: sources.createdAt, meta: sources.meta, ownerName: users.name,
  };
  // Passages of someone else's sensitive file are never searched (its name still is).
  const ownWords = sql`(not ${sources.sensitive} or ${sources.ownerId} = ${c.v.id})`;
  const textMatch = or(
    q && !c.p.ref ? sql`${chunks.search} @@ to_tsquery('simple', ${q})` : undefined,
    allLike(sql`${chunks.text}`, c),
  );
  const chunkRank = q ? sql<number>`ts_rank(coalesce(${chunks.search}, ''::tsvector), to_tsquery('simple', ${q}))` : sql<number>`0.05`;
  const [titleRows, chunkRows, semRows] = await Promise.all([
    db.select(srcCols).from(sources).leftJoin(users, eq(users.id, sources.ownerId))
      .where(and(base, allLike(sql`${sources.title}`, c))).orderBy(desc(sources.createdAt)).limit(fetchN(c)),
    textMatch ? db.select({ ...srcCols, chunkId: chunks.id, text: chunks.text, locator: chunks.locator, rank: chunkRank })
      .from(chunks).innerJoin(sources, eq(sources.id, chunks.sourceId)).leftJoin(users, eq(users.id, sources.ownerId))
      .where(and(base, ownWords, eq(chunks.graphId, c.v.graphId), textMatch))
      .orderBy(desc(chunkRank), desc(sources.createdAt)).limit(fetchN(c) * 4) : Promise.resolve([]),
    semantic ? db.select({ ...srcCols, chunkId: chunks.id, text: chunks.text, locator: chunks.locator,
      rank: sql<number>`1 - (${chunks.embedding} <=> ${JSON.stringify(semantic)}::vector)` })
      .from(chunks).innerJoin(sources, eq(sources.id, chunks.sourceId)).leftJoin(users, eq(users.id, sources.ownerId))
      .where(and(base, ownWords, eq(chunks.graphId, c.v.graphId), isNotNull(chunks.embedding)))
      .orderBy(sql`${chunks.embedding} <=> ${JSON.stringify(semantic)}::vector`).limit(12) : Promise.resolve([]),
  ]);
  type SrcRow = (typeof titleRows)[number];
  const fileHit = (r: SrcRow, score: number, via: Hit["via"], chunk?: { id: string; text: string; locator: Record<string, unknown> | null }): Hit => {
    const showText = snippetAllowed(c.v, r);
    const loc = (chunk?.locator ?? {}) as { page?: number; slide?: number; time?: number; timeStartSec?: number; sheet?: string };
    const snippet = chunk && showText ? makeSnippet(chunk.text, c.needles, 160) : null;
    const locator = chunk ? {
      page: typeof loc.page === "number" ? loc.page : undefined, slide: typeof loc.slide === "number" ? loc.slide : undefined,
      time: typeof loc.timeStartSec === "number" ? loc.timeStartSec : typeof loc.time === "number" ? Math.round(loc.time / 1000) : undefined,
      sheet: typeof loc.sheet === "string" ? loc.sheet : undefined,
    } : null;
    return {
      key: `file:${r.id}`, section: "files", kind: "file", id: r.id, title: r.title,
      href: `/library/${r.id}${chunk && showText ? passageAnchor(chunk.id, locator?.page, snippet) : ""}`,
      titleRanges: findRanges(r.title, c.needles), context: [],
      snippet,
      locator: showText ? locator : null, sub: r.mime, date: iso(r.documentDate ?? r.createdAt), ownerName: r.ownerName,
      sensitive: !showText, score, via,
    };
  };
  const hits: Hit[] = [];
  for (const r of titleRows) {
    const ls = labelScore(r.title.replace(/\.[a-z0-9]{2,5}$/i, ""), [], c.p.text, c.terms) ?? labelScore(r.title, [], c.p.text, c.terms);
    hits.push(fileHit(r, ls?.score ?? TIER.allWords, "title"));
  }
  const seen = new Set<string>();
  for (const r of chunkRows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    const h = fileHit(r, textScore(Number(r.rank)) + (c.p.ref ? 8 : 0), "text", { id: r.chunkId, text: r.text, locator: r.locator as Record<string, unknown> });
    const titled = hits.find((x) => x.key === h.key);
    if (titled) { titled.snippet = h.snippet; titled.locator = h.locator; titled.href = h.href; } else hits.push(h);
  }
  const semSeen = new Set<string>();
  const mean: Hit[] = [];
  for (const r of semRows) {
    if (semSeen.has(r.id) || Number(r.rank) < MEANING_MIN || mean.length >= 3) continue;
    semSeen.add(r.id);
    mean.push(fileHit(r, meaningScore(Number(r.rank)), "meaning", { id: r.chunkId, text: r.text, locator: r.locator as Record<string, unknown> }));
  }
  const res = finish(mergeHits([hits, mean]), c);
  for (const h of res.items) {
    const kindWord = fileKindWord(c.t, h.sub ?? null, h.title);
    const where = h.locator?.page ? c.t("search.loc.page", { n: h.locator.page }) : h.locator?.slide ? c.t("search.loc.slide", { n: h.locator.slide })
      : h.locator?.time !== undefined ? c.t("search.loc.time", { t: clock(h.locator.time) }) : h.locator?.sheet ? h.locator.sheet : "";
    h.context = [kindWord, where].filter(Boolean);
  }
  return res;
}

/** "#chunk-<id>.p3.q<words>": the library page marks the words (the first match) and turns a PDF to the page. */
function passageAnchor(chunkId: string, page: number | undefined, snippet: { text: string; ranges: [number, number][] } | null): string {
  const rs = snippet?.ranges ?? [];
  let words = "";
  if (rs.length) {
    // Join neighbouring matches ("packed" + "lunch" → "packed lunch") so the whole phrase is marked.
    const a = rs[0][0];
    let b = rs[0][1];
    for (const [x, y] of rs.slice(1)) { if (/^\s{1,2}$/.test(snippet!.text.slice(b, x))) b = y; else break; }
    words = snippet!.text.slice(a, b);
  }
  return `#chunk-${chunkId}${page ? `.p${page}` : ""}${words ? `.q${encodeURIComponent(words)}` : ""}`;
}

function clock(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function fileKindWord(t: TFn, mime: string | null, title = ""): string {
  const m = (mime ?? "").toLowerCase();
  if (m === "application/pdf") return "PDF";
  if (m.includes("wordprocessingml") || m === "application/msword") return t("search.file.word");
  if (m.includes("presentationml")) return t("search.file.slides");
  if (m.includes("spreadsheetml") || m === "text/csv") return t("search.file.sheet");
  if (m.startsWith("image/")) return t("search.file.photo");
  if (m.startsWith("audio/")) return t("search.file.audio");
  if (m === "message/rfc822") return t("search.file.email");
  if (m === "text/html" || /^https?:/.test(title)) return t("search.file.web");
  if (m.startsWith("text/")) return t("search.file.note");
  return t("search.file.file");
}

async function madeSection(c: Ctx): Promise<{ items: Hit[]; more: boolean }> {
  const kinds = c.p.filter?.madeKinds;
  const wantPages = !kinds || kinds.includes("page");
  const wantArts = !kinds || kinds.includes("document") || kinds.includes("deck");
  const s = scopeOf(c.v);
  const [pages, arts] = await Promise.all([
    wantPages && s.role !== "guest" ? db.select({
      id: wikiPages.id, slug: wikiPages.slug, title: wikiPages.title, text: wikiPages.contentText, ownerId: wikiPages.ownerId,
      updatedAt: wikiPages.updatedAt, ownerName: users.name,
    }).from(wikiPages).leftJoin(users, eq(users.id, wikiPages.ownerId))
      .where(and(pageReadSql(c.v, "wiki_pages"), or(allLike(sql`${wikiPages.title}`, c), allLike(sql`${wikiPages.contentText}`, c)),
        ownerCond(sql`${wikiPages.ownerId}`, c), dateRange(sql`${wikiPages.updatedAt}`, c)))
      .orderBy(desc(wikiPages.updatedAt)).limit(fetchN(c)) : Promise.resolve([]),
    wantArts && s.graphId && s.role !== "guest" ? db.select({
      id: artifacts.id, kind: artifacts.kind, title: artifacts.title, status: artifacts.status, visibility: artifacts.visibility,
      graphId: artifacts.graphId, ownerId: artifacts.ownerId, sensitive: artifacts.sensitive, updatedAt: artifacts.updatedAt, ownerName: users.name,
      content: artifacts.content,
    }).from(artifacts).leftJoin(users, eq(users.id, artifacts.ownerId))
      .where(and(eq(artifacts.graphId, s.graphId), or(eq(artifacts.ownerId, c.v.id), eq(artifacts.status, "published")),
        or(allLike(sql`${artifacts.title}`, c), allLike(sql`${artifacts.content}::text`, c)),
        ownerCond(sql`${artifacts.ownerId}`, c), dateRange(sql`${artifacts.updatedAt}`, c)))
      .orderBy(desc(artifacts.updatedAt)).limit(fetchN(c)) : Promise.resolve([]),
  ]);
  const hits: Hit[] = [];
  for (const p of pages) {
    const ls = labelScore(p.title, [], c.p.text, c.terms);
    hits.push({
      key: `page:${p.id}`, section: "made", kind: "page", id: p.id, title: p.title, href: madeHref({ kind: "page", id: p.id, slug: p.slug }),
      titleRanges: findRanges(p.title, c.needles), context: [c.t("search.kinds.page")],
      snippet: !ls || c.mode === "full" ? makeSnippet(p.text, c.needles, 150) : null,
      date: iso(p.updatedAt), ownerName: p.ownerName, score: ls?.score ?? TIER.text + 6, via: ls ? "title" : "text",
    });
  }
  for (const a of arts) {
    if (!canSeeArtifact(s, a)) continue;
    const kind = madeKindOf(a.kind) === "deck" ? "deck" : "document";
    if (kinds && !kinds.includes(kind)) continue;
    const ls = labelScore(a.title, [], c.p.text, c.terms);
    if (!ls && !snippetAllowed(c.v, a)) continue;
    const body = !ls || c.mode === "full" ? jsonText(a.content) : "";
    hits.push({
      key: `${kind}:${a.id}`, section: "made", kind, id: a.id, title: a.title, href: madeHref({ kind, id: a.id }),
      titleRanges: findRanges(a.title, c.needles),
      context: [c.t(`search.kinds.${kind}`), a.status === "published" ? "" : c.t("search.draft")].filter(Boolean),
      snippet: body && snippetAllowed(c.v, a) ? makeSnippet(body, c.needles, 150) : null,
      date: iso(a.updatedAt), ownerName: a.ownerName, sensitive: !snippetAllowed(c.v, a), score: ls?.score ?? TIER.text + 4, via: ls ? "title" : "text",
    });
  }
  return finish(hits, c);
}

async function rulesSection(c: Ctx): Promise<{ items: Hit[]; more: boolean }> {
  const s = scopeOf(c.v);
  const manage = s.canWrite && (!s.family || c.parent);
  const statuses = manage ? ["active", "proposed"] : ["active"];
  const hay = sql`(${corpusRules.ref} || ' ' || ${corpusRules.title} || ' ' || ${corpusRules.text} || ' ' || ${corpora.name} || ' ' || coalesce(${corpusRules.unitKey}, ''))`;
  const refOnly = c.p.ref ? and(...c.terms.filter((t) => !/^\d+$/.test(t) && !["stk", "paragraf", "art", "artikel"].includes(t)).map((t) => sql`${hay} ilike ${likePattern(t)}`),
    sql`(${corpusRules.ref} ~* ${refRegex(c.p.ref)} or coalesce(${corpusRules.unitKey}, '') ~* ${refRegex(c.p.ref)})`) : undefined;
  const match = c.p.ref ? refOnly : allLike(hay, c);
  if (!match) return { items: [], more: false };
  const [rules, sets] = await Promise.all([
    db.select({
      id: corpusRules.id, corpusId: corpusRules.corpusId, corpusName: corpora.name, ref: corpusRules.ref, title: corpusRules.title,
      text: corpusRules.text, kind: corpusRules.kind, status: corpusRules.status, updatedAt: corpusRules.updatedAt,
    }).from(corpusRules).innerJoin(corpora, eq(corpora.id, corpusRules.corpusId))
      .where(and(eq(corpusRules.graphId, c.v.graphId), eq(corpora.graphId, c.v.graphId), ne(corpora.status, "retired"),
        inArray(corpusRules.status, statuses), match, dateRange(sql`${corpusRules.updatedAt}`, c)))
      // A reference query wants "§ 3" before "§ 3, stk. 12": shortest refs first; otherwise the newest.
      .orderBy(...(c.p.ref ? [sql`length(${corpusRules.ref})`, corpusRules.ref] : [desc(corpusRules.updatedAt)])).limit(fetchN(c) * 2),
    c.p.ref ? Promise.resolve([]) : db.select({ id: corpora.id, name: corpora.name, description: corpora.description, authority: corpora.authority, updatedAt: corpora.updatedAt })
      .from(corpora).where(and(eq(corpora.graphId, c.v.graphId), ne(corpora.status, "retired"), allLike(sql`(${corpora.name} || ' ' || coalesce(${corpora.authority}, ''))`, c)))
      .orderBy(desc(corpora.updatedAt)).limit(5),
  ]);
  const hits: Hit[] = [];
  const refNeedles = c.p.ref ? [`${c.p.ref.mark} ${c.p.ref.number}`, `${c.p.ref.mark}${c.p.ref.number}`] : [];
  for (const r of sets) {
    const ls = labelScore(r.name, [], c.p.text, c.terms);
    hits.push({
      key: `ruleset:${r.id}`, section: "rules", kind: "ruleset", id: r.id, title: r.name, href: `/rules/${r.id}`,
      titleRanges: findRanges(r.name, c.needles), context: [c.t("search.kinds.ruleset"), r.authority ?? ""].filter(Boolean),
      date: iso(r.updatedAt), score: (ls?.score ?? TIER.allWords) + 2, via: "title",
    });
  }
  for (const r of rules) {
    const refNorm = r.ref.replace(/\s+/g, " ").trim().toLowerCase();
    const want = c.p.ref ? `${c.p.ref.mark} ${c.p.ref.number}${c.p.ref.stk ? `, stk. ${c.p.ref.stk}` : ""}` : "";
    const refHit = c.p.ref ? (refNorm.replace(/§\s*/, "§ ") === want ? TIER.exact : TIER.wordPrefix) : 0;
    const ls = labelScore(r.title, [r.ref], c.p.text, c.terms);
    // Among sub-parts of the same §, stk. 1 before stk. 10.
    const stk = Number(r.ref.match(/stk\.?\s*(\d+)/i)?.[1] ?? 0);
    const score = (Math.max(refHit, ls?.score ?? 0) || TIER.text + 6) - Math.min(stk, 60) * 0.1;
    const title = `${r.ref} ${r.title}`.trim();
    const kind: HitKind = r.kind === "definition" ? "definition" : "rule";
    hits.push({
      key: `rule:${r.id}`, section: "rules", kind, id: r.id, title, href: `/rules/${r.corpusId}#rule-${r.id}`,
      titleRanges: findRanges(title, [...refNeedles, ...c.needles]),
      context: [c.t(`search.kinds.${kind}`), `${r.corpusName} ${r.ref}`, r.status === "proposed" ? c.t("search.proposed") : ""].filter(Boolean),
      snippet: makeSnippet(r.text, c.needles, 150), date: iso(r.updatedAt), score, via: score >= TIER.allWords ? "title" : "text",
    });
  }
  return finish(hits, c);
}

async function chatsSection(c: Ctx): Promise<{ items: Hit[]; more: boolean }> {
  const mine = and(eq(conversations.userId, c.v.id), eq(conversations.graphId, c.v.graphId));
  if (c.input.owner === "others") return { items: [], more: false };
  const [titled, inMessages] = await Promise.all([
    db.select({ id: conversations.id, title: conversations.title, updatedAt: conversations.updatedAt }).from(conversations)
      .where(and(mine, allLike(sql`${conversations.title}`, c), dateRange(sql`${conversations.updatedAt}`, c)))
      .orderBy(desc(conversations.updatedAt)).limit(fetchN(c)),
    db.select({ id: conversations.id, title: conversations.title, updatedAt: conversations.updatedAt, content: messages.content, role: messages.role })
      .from(messages).innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .where(and(mine, allLike(sql`${messages.content}`, c), dateRange(sql`${conversations.updatedAt}`, c)))
      .orderBy(desc(messages.createdAt)).limit(fetchN(c) * 3),
  ]);
  const hits = new Map<string, Hit>();
  for (const r of titled) {
    const ls = labelScore(r.title, [], c.p.text, c.terms);
    hits.set(r.id, {
      key: `chat:${r.id}`, section: "chats", kind: "chat", id: r.id, title: r.title, href: `/chat/${r.id}`,
      titleRanges: findRanges(r.title, c.needles), context: [c.t("search.kinds.chat")], date: iso(r.updatedAt),
      score: ls?.score ?? TIER.allWords, via: "title",
    });
  }
  for (const r of inMessages) {
    const h = hits.get(r.id);
    const snippet = makeSnippet(plainText(r.content), c.needles, 150);
    if (h) { h.snippet ??= snippet; continue; }
    hits.set(r.id, {
      key: `chat:${r.id}`, section: "chats", kind: "chat", id: r.id, title: r.title, href: `/chat/${r.id}`,
      titleRanges: findRanges(r.title, c.needles), context: [c.t("search.kinds.chat"), c.t(r.role === "user" ? "search.youAsked" : "search.assistantSaid")],
      snippet, date: iso(r.updatedAt), score: TIER.text + 3, via: "text",
    });
  }
  return finish([...hits.values()], c);
}

/** A chat message without its markdown and citation marks ("**Dr. Lund** [4][16]" → "Dr. Lund"). */
function plainText(md: string): string {
  return md.replace(/\[\d+\]/g, "").replace(/[*_`#>]+/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/\s+/g, " ").trim();
}

async function changesSection(c: Ctx): Promise<{ items: Hit[]; more: boolean }> {
  if (c.v.role === "guest") return { items: [], more: false };
  const rows = await db.select({
    id: changeSets.id, title: changeSets.title, titleKey: changeSets.titleKey, titleParams: changeSets.titleParams,
    description: changeSets.description, origin: changeSets.origin, createdAt: changeSets.createdAt, createdBy: changeSets.createdBy,
  }).from(changeSets)
    .where(and(await changeSetVisibleSql(c.v), eq(changeSets.status, "draft"),
      or(allLike(sql`${changeSets.title}`, c), allLike(sql`coalesce(${changeSets.description}, '')`, c)),
      ownerCond(sql`coalesce(${changeSets.createdBy}::text, '')`, c), dateRange(sql`${changeSets.createdAt}`, c)))
    .orderBy(desc(changeSets.createdAt)).limit(fetchN(c));
  const hits: Hit[] = rows.map((r) => {
    const title = localizeTitle(r, c.t);
    const ls = labelScore(title, [r.title], c.p.text, c.terms);
    return {
      key: `change:${r.id}`, section: "changes", kind: "change", id: r.id, title, href: `/changes/${r.id}`,
      titleRanges: findRanges(title, c.needles), context: [c.t("search.kinds.change"), c.t("search.waiting")],
      snippet: !ls && r.description ? makeSnippet(r.description, c.needles, 140) : null,
      date: iso(r.createdAt), score: ls?.score ?? TIER.text + 2, via: ls ? "title" : "text",
    } satisfies Hit;
  });
  return finish(hits, c);
}

/* ── Entry point ─────────────────────────────────────────────────────────────────────────────────────── */

const EMPTY = (q: string, ms = 0): SearchResponse => ({ q, filter: null, top: null, sections: [], semantic: false, ms });

/** Embedding of the query, or null (mux down, slow, or the query too short to mean anything). */
async function queryVector(v: Viewer, text: string, budgetMs: number): Promise<number[] | null> {
  if (text.replace(/[^\p{L}\p{N}]/gu, "").length < 4) return null;
  try {
    const out = await Promise.race([
      embed([text.slice(0, 300)], { userId: v.id, agent: "my-graph:search", graphId: v.graphId }),
      new Promise<null>((r) => setTimeout(() => r(null), budgetMs)),
    ]);
    const vec = out?.[0];
    return vec && vec.length === 1024 ? vec : null;
  } catch {
    return null;
  }
}

export async function search(v: Viewer, input: SearchInput): Promise<SearchResponse> {
  const started = performance.now();
  const p = parseQuery(input.q);
  if (!searchable(p)) return EMPTY(p.text);
  const allowed = new Set(sectionsFor(v));
  const asked = input.types?.length ? input.types : p.filter?.sections ?? [...SECTIONS];
  const wanted = SECTIONS.filter((s) => asked.includes(s) && allowed.has(s));
  const mode = input.mode ?? "quick";
  const [ctx, t, locale, vec] = await Promise.all([
    accessContext(v), getT(), getLocale(),
    mode === "full" && !p.ref && (input.sort ?? "relevance") === "relevance" ? queryVector(v, p.text, 900) : Promise.resolve(null),
  ]);
  if (!ctx.active || !wanted.length) return { ...EMPTY(p.text), filter: p.filter ? { sections: p.filter.sections, label: p.filter.label } : null };
  const terms = textTerms(p);
  const base: Omit<Ctx, "cap"> = {
    v, ctx, p, terms, needles: [...p.phrases, ...terms], t, locale, mode,
    offset: Math.max(0, input.offset ?? 0), input, parent: v.role === "owner" || v.role === "parent",
  };
  const capFor = (s: Section) => mode === "quick" ? QUICK_CAPS[s] : Math.min(50, input.limit ?? (wanted.length === 1 ? 20 : 6));
  const run = async (s: Section): Promise<SectionResult> => {
    const c: Ctx = { ...base, cap: capFor(s), offset: wanted.length === 1 ? base.offset : 0 };
    try {
      const r = s === "nodes" || s === "events" ? await nodesSection(c, s, vec)
        : s === "files" ? await filesSection(c, vec)
        : s === "made" ? await madeSection(c)
        : s === "rules" ? await rulesSection(c)
        : s === "chats" ? await chatsSection(c)
        : await changesSection(c);
      return { id: s, ...r };
    } catch (e) {
      console.error(`[search] ${s}`, e instanceof Error ? e.message : e);
      return { id: s, items: [], more: false };
    }
  };
  const sections = (await Promise.all(wanted.map(run))).filter((s) => s.items.length);
  return {
    q: p.text,
    filter: p.filter ? { sections: p.filter.sections, label: p.filter.label } : null,
    top: base.offset ? null : pickTop(sections),
    sections,
    semantic: !!vec,
    ms: Math.round(performance.now() - started),
  };
}

export { parseQuery } from "./query";
export type { SearchResponse, Hit, Section } from "./types";
