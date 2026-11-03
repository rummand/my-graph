/**
 * Wiki pages: per-household pages with an owner, visibility, full revision history and a footprint in the graph.
 * Server-only. Reads of wiki rows are checked here (./access), not through GBrain.
 */
import { and, desc, eq, inArray, like, ne, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/db";
import { edges, nodes, provenance, sources, users, wikiPages, wikiRevisions } from "@/db/schema";
import { audit, type Viewer } from "@/lib/auth";
import { readableNodeIds } from "@/lib/gbrain";
import { scopeOf } from "@/lib/graphs/pure";
import {
  canChangeVisibility, canDeletePage, canEditPage, canReadPage, pagePermissions, pageReadSql,
  type PagePermissions, type Visibility,
} from "./access";
import { docToText, EMPTY_DOC, excerpt, extractMentions, extractPageLinks, sameDoc, sanitizeDoc, type Doc, type DocNode } from "./doc";
import { WikiError } from "./errors";
import { cancelPendingIngest, syncPageGraphLater } from "./graph-sync";
import { slugify, uniqueSlug } from "./slug";

export { WikiError };
export type { Visibility, PagePermissions };

/* ── Types ─────────────────────────────────────────────────────────────────────────────────────────────── */

export type WikiPageSummary = {
  id: string; slug: string; title: string; excerpt: string; visibility: Visibility;
  ownerId: string; ownerName: string; updatedAt: Date; updatedByName: string | null;
};

export type WikiPage = {
  id: string; slug: string; title: string; content: Doc; contentText: string; visibility: Visibility; version: number;
  ownerId: string; ownerName: string; nodeId: string | null; sourceId: string | null;
  createdAt: Date; updatedAt: Date; updatedByName: string | null;
  can: PagePermissions;
};

export type WikiRevisionSummary = {
  id: string; version: number; title: string; authorKind: "user" | "assistant"; authorName: string;
  summary: string | null; createdAt: Date;
};

export type WikiRevision = WikiRevisionSummary & { content: Doc; contentText: string };

export type Backlinks = {
  pages: { id: string; slug: string; title: string; via: "link" | "mention" }[];
  mentions: { id: string; label: string; type: string; readable: boolean }[];
};

/** An autosave folds into the previous revision when the same person saved it within this window. */
const COALESCE_MS = 10 * 60 * 1000;

const owner = alias(users, "owner_user");
const editor = alias(users, "editor_user");

/* ── Helpers ───────────────────────────────────────────────────────────────────────────────────────────── */

function safeAudit(v: Viewer, action: string, target: { type: string; id: string }, meta: Record<string, unknown> = {}) {
  try {
    void audit(v, action, target, meta).catch(() => {});
  } catch {
    /* audit unavailable: never block a page write */
  }
}

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

const pageCols = {
  id: wikiPages.id, householdId: wikiPages.householdId, graphId: wikiPages.graphId, ownerId: wikiPages.ownerId, slug: wikiPages.slug, title: wikiPages.title,
  content: wikiPages.content, contentText: wikiPages.contentText, nodeId: wikiPages.nodeId, sourceId: wikiPages.sourceId,
  visibility: wikiPages.visibility, version: wikiPages.version, createdAt: wikiPages.createdAt, updatedAt: wikiPages.updatedAt,
  ownerName: owner.name, updatedByName: editor.name,
};

type Row = NonNullable<Awaited<ReturnType<typeof loadRow>>>;

function toPage(v: Viewer, r: Row): WikiPage {
  return {
    id: r.id, slug: r.slug, title: r.title, content: r.content as Doc, contentText: r.contentText, visibility: r.visibility,
    version: r.version, ownerId: r.ownerId, ownerName: r.ownerName ?? "Someone", nodeId: r.nodeId, sourceId: r.sourceId,
    createdAt: r.createdAt, updatedAt: r.updatedAt, updatedByName: r.updatedByName ?? null,
    can: pagePermissions(v, r),
  };
}

/** Slugs are unique per graph: a page is looked up in the viewer's current graph only. */
async function loadRow(graphId: string, slug: string) {
  const [r] = await db.select(pageCols).from(wikiPages)
    .leftJoin(owner, eq(owner.id, wikiPages.ownerId))
    .leftJoin(editor, eq(editor.id, wikiPages.updatedBy))
    .where(and(eq(wikiPages.graphId, graphId), eq(wikiPages.slug, slug))).limit(1);
  return r ?? null;
}

/** The page if the viewer may read it; a 404 otherwise (we don't reveal that a hidden page exists). */
async function readablePage(v: Viewer, slug: string) {
  const r = await loadRow(v.graphId, slug);
  if (!r || !canReadPage(v, r)) throw new WikiError(404, "This page doesn't exist, or it hasn't been shared with you.");
  return r;
}

function cleanTitle(t: string): string {
  const s = t.replace(/\s+/g, " ").trim();
  if (!s) throw new WikiError(400, "Give the page a title.");
  if (s.length > 200) throw new WikiError(400, "Keep the title under 200 characters.");
  return s;
}

/* ── Reads ─────────────────────────────────────────────────────────────────────────────────────────────── */

/** Pages the viewer can see, most recently edited first. `q` matches title and text (title matches rank first). */
export async function listPages(v: Viewer, opts: { q?: string; limit?: number } = {}): Promise<WikiPageSummary[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const q = opts.q?.trim();
  const pattern = q ? `%${likeEscape(q)}%` : null;
  const rows = await db.select({
    id: wikiPages.id, slug: wikiPages.slug, title: wikiPages.title, contentText: wikiPages.contentText,
    visibility: wikiPages.visibility, ownerId: wikiPages.ownerId, updatedAt: wikiPages.updatedAt,
    ownerName: owner.name, updatedByName: editor.name,
  }).from(wikiPages)
    .leftJoin(owner, eq(owner.id, wikiPages.ownerId))
    .leftJoin(editor, eq(editor.id, wikiPages.updatedBy))
    .where(and(
      pageReadSql(v),
      pattern ? or(sql`${wikiPages.title} ilike ${pattern}`, sql`${wikiPages.contentText} ilike ${pattern}`) : undefined,
    ))
    .orderBy(...(pattern ? [sql`(${wikiPages.title} ilike ${pattern}) desc`, desc(wikiPages.updatedAt)] : [desc(wikiPages.updatedAt)]))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id, slug: r.slug, title: r.title, visibility: r.visibility, ownerId: r.ownerId, ownerName: r.ownerName ?? "Someone",
    updatedAt: r.updatedAt, updatedByName: r.updatedByName ?? null, excerpt: snippet(r.contentText, q),
  }));
}

/** Excerpt around the first match of `q`, or the start of the text. */
function snippet(text: string, q?: string): string {
  if (q) {
    const i = text.toLowerCase().indexOf(q.toLowerCase());
    if (i > 40) return "…" + excerpt(text.slice(i - 40), 160);
  }
  return excerpt(text, 160);
}

export async function getPage(v: Viewer, slug: string): Promise<WikiPage | null> {
  const r = await loadRow(v.graphId, slug);
  if (!r || !canReadPage(v, r)) return null;
  return toPage(v, r);
}

/** Other pages that link to or mention this page, and the graph nodes this page mentions. */
export async function getBacklinks(v: Viewer, page: Pick<WikiPage, "id" | "nodeId" | "content">): Promise<Backlinks> {
  const idNeedle = `%"${page.id}"%`;
  const nodeNeedle = page.nodeId ? `%"${page.nodeId}"%` : null;
  const rows = await db.select({ id: wikiPages.id, slug: wikiPages.slug, title: wikiPages.title, content: wikiPages.content })
    .from(wikiPages)
    .where(and(
      pageReadSql(v), ne(wikiPages.id, page.id),
      or(like(sql`${wikiPages.content}::text`, idNeedle), nodeNeedle ? like(sql`${wikiPages.content}::text`, nodeNeedle) : undefined),
    ))
    .orderBy(desc(wikiPages.updatedAt)).limit(50);
  const pages: Backlinks["pages"] = [];
  for (const r of rows) {
    const doc = r.content as DocNode;
    if (extractPageLinks(doc).some((l) => l.id === page.id)) pages.push({ id: r.id, slug: r.slug, title: r.title, via: "link" });
    else if (page.nodeId && extractMentions(doc).some((m) => m.id === page.nodeId)) pages.push({ id: r.id, slug: r.slug, title: r.title, via: "mention" });
  }

  const mentioned = extractMentions(page.content);
  let readable = new Set<string>(mentioned.map((m) => m.id));
  try {
    readable = await readableNodeIds(v, mentioned.map((m) => m.id));
  } catch {
    /* GBrain unavailable: show the labels written in the page, without links */
    readable = new Set();
  }
  const current = readable.size
    ? await db.select({ id: nodes.id, label: nodes.label, type: nodes.type }).from(nodes).where(inArray(nodes.id, [...readable]))
    : [];
  const byId = new Map(current.map((n) => [n.id, n]));
  const mentions = mentioned.map((m) => {
    const n = byId.get(m.id);
    return n ? { id: m.id, label: n.label, type: n.type as string, readable: true } : { id: m.id, label: m.label, type: m.nodeType ?? "topic", readable: false };
  });
  return { pages, mentions };
}

/** People mentioned across the pages the viewer can see, each with their most recent pages. */
export async function pagesByPerson(v: Viewer, opts: { people?: number; perPerson?: number } = {}): Promise<{ person: { id: string; label: string }; pages: { slug: string; title: string }[]; total: number }[]> {
  const rows = await db.execute<{ id: string; slug: string; title: string; updated_at: string; person_id: string; label: string }>(sql`
    select distinct p.id, p.slug, p.title, p.updated_at, m->>'id' as person_id, m->>'label' as label
    from wiki_pages p, lateral jsonb_path_query(p.content, 'lax $.**.attrs ? (@.nodeType == "person")') m
    where ${pageReadSql(v, "p")}
    order by p.updated_at desc
    limit 2000`);
  const list = Array.from(rows as Iterable<{ id: string; slug: string; title: string; person_id: string; label: string }>);
  const ids = [...new Set(list.map((r) => r.person_id))];
  let readable: Set<string>;
  try {
    readable = await readableNodeIds(v, ids);
  } catch {
    return [];
  }
  const labels = readable.size
    ? new Map((await db.select({ id: nodes.id, label: nodes.label }).from(nodes).where(inArray(nodes.id, [...readable]))).map((n) => [n.id, n.label]))
    : new Map<string, string>();
  const groups = new Map<string, { person: { id: string; label: string }; pages: { slug: string; title: string }[]; seen: Set<string> }>();
  for (const r of list) {
    if (!readable.has(r.person_id)) continue;
    let gr = groups.get(r.person_id);
    if (!gr) groups.set(r.person_id, gr = { person: { id: r.person_id, label: labels.get(r.person_id) ?? r.label }, pages: [], seen: new Set() });
    if (gr.seen.has(r.id)) continue;
    gr.seen.add(r.id);
    gr.pages.push({ slug: r.slug, title: r.title });
  }
  const perPerson = opts.perPerson ?? 5;
  return [...groups.values()]
    .sort((a, b) => b.pages.length - a.pages.length || a.person.label.localeCompare(b.person.label))
    .slice(0, opts.people ?? 12)
    .map((gr) => ({ person: gr.person, pages: gr.pages.slice(0, perPerson), total: gr.pages.length }));
}

/* ── Writes ────────────────────────────────────────────────────────────────────────────────────────────── */

export async function createPage(v: Viewer, input: { title: string; visibility?: Visibility; content?: unknown }): Promise<WikiPage> {
  if (v.role === "guest" && scopeOf(v).family) throw new WikiError(403, "Guests can't create wiki pages.");
  if (!scopeOf(v).canWrite) throw new WikiError(403, "You can look at this graph but not add pages to it.");
  const title = cleanTitle(input.title);
  const content = input.content === undefined ? EMPTY_DOC : sanitizeDoc(input.content);
  const contentText = docToText(content);
  const base = slugify(title);

  let created: { id: string; slug: string } | null = null;
  for (let attempt = 0; attempt < 4 && !created; attempt++) {
    const taken = await db.select({ slug: wikiPages.slug }).from(wikiPages)
      .where(and(eq(wikiPages.graphId, v.graphId), or(eq(wikiPages.slug, base), like(wikiPages.slug, `${likeEscape(base)}-%`))));
    const slug = uniqueSlug(base, taken.map((t) => t.slug));
    try {
      created = await db.transaction(async (tx) => {
        const [p] = await tx.insert(wikiPages).values({
          householdId: v.graphHouseholdId, graphId: v.graphId, ownerId: v.id, slug, title, content, contentText,
          visibility: input.visibility ?? "private", version: 1, updatedBy: v.id,
        }).returning({ id: wikiPages.id, slug: wikiPages.slug });
        await tx.insert(wikiRevisions).values({
          pageId: p.id, version: 1, title, content, contentText, authorId: v.id, authorKind: "user", summary: "Created the page",
        });
        return p;
      });
    } catch (e) {
      if ((e as { code?: string })?.code === "23505" || /wiki_graph_slug_idx/.test(String((e as Error)?.message))) continue; // slug race
      throw e;
    }
  }
  if (!created) throw new WikiError(409, "Couldn't find a free address for this page. Try a slightly different title.");

  safeAudit(v, "wiki.create", { type: "wiki_page", id: created.id });
  syncPageGraphLater(v, created.id, null);
  const page = await getPage(v, created.slug);
  if (!page) throw new WikiError(404, "The page was created but couldn't be loaded.");
  return page;
}

export type SaveResult = { page: WikiPage; changed: boolean };

/**
 * Save title and/or content with an optimistic version check. A stale `version` throws 409 with the current page in
 * `details.current` unless `force` is set (the user chose "overwrite").
 */
export async function updatePage(v: Viewer, slug: string, input: { version: number; title?: string; content?: unknown; force?: boolean }): Promise<SaveResult> {
  const content = input.content === undefined ? undefined : sanitizeDoc(input.content);
  const title = input.title === undefined ? undefined : cleanTitle(input.title);
  return save(v, slug, input.version, { title, content, force: !!input.force });
}

async function save(
  v: Viewer, slug: string, version: number,
  input: { title?: string; content?: Doc; force: boolean; summary?: string },
): Promise<SaveResult> {
  const cur0 = await readablePage(v, slug);
  if (!canEditPage(v, cur0)) throw new WikiError(403, "You can read this page but not change it. Ask its owner to share it with the family.");

  const res = await db.transaction(async (tx) => {
    const [cur] = await tx.select().from(wikiPages).where(eq(wikiPages.id, cur0.id)).for("update");
    if (!cur) throw new WikiError(404, "This page was deleted while you were editing it.");
    if (cur.version !== version && !input.force) {
      const [by] = cur.updatedBy ? await tx.select({ name: users.name }).from(users).where(eq(users.id, cur.updatedBy)) : [];
      const who = cur.updatedBy === v.id ? "You changed this page in another tab or window" : `${by?.name ?? "Someone"} changed this page`;
      throw new WikiError(409, `${who} while you were editing it here.`, {
        current: { version: cur.version, title: cur.title, content: cur.content, updatedAt: cur.updatedAt, updatedByName: by?.name ?? null },
      });
    }
    const title = input.title ?? cur.title;
    const content = input.content ?? (cur.content as Doc);
    if (title === cur.title && sameDoc(content, cur.content) && !input.summary) return { prev: null, id: cur.id };

    const contentText = docToText(content);
    const nextVersion = cur.version + 1;
    const now = new Date();
    await tx.update(wikiPages).set({ title, content, contentText, version: nextVersion, updatedBy: v.id, updatedAt: now })
      .where(eq(wikiPages.id, cur.id));

    const [last] = await tx.select().from(wikiRevisions).where(eq(wikiRevisions.pageId, cur.id))
      .orderBy(desc(wikiRevisions.version)).limit(1);
    const coalesce = !input.summary && last && last.summary === null && last.authorKind === "user" && last.authorId === v.id
      && now.getTime() - last.createdAt.getTime() < COALESCE_MS && last.version === cur.version;
    if (coalesce) {
      await tx.update(wikiRevisions).set({ version: nextVersion, title, content, contentText, createdAt: now }).where(eq(wikiRevisions.id, last.id));
    } else {
      await tx.insert(wikiRevisions).values({
        pageId: cur.id, version: nextVersion, title, content, contentText, authorId: v.id, authorKind: "user", summary: input.summary ?? null,
      });
    }
    return { prev: { title: cur.title, visibility: cur.visibility, content: cur.content as DocNode }, id: cur.id };
  });

  if (res.prev) syncPageGraphLater(v, res.id, res.prev);
  const page = await getPage(v, slug);
  if (!page) throw new WikiError(404, "This page is no longer available to you.");
  return { page, changed: !!res.prev };
}

/** Change who can see the page (owner only). Doesn't create a revision or bump the version. */
export async function setVisibility(v: Viewer, slug: string, visibility: Visibility): Promise<WikiPage> {
  const cur = await readablePage(v, slug);
  if (!canChangeVisibility(v, cur)) throw new WikiError(403, "Only the person who created this page can change who sees it.");
  if (cur.visibility !== visibility) {
    await db.update(wikiPages).set({ visibility }).where(eq(wikiPages.id, cur.id));
    safeAudit(v, "wiki.visibility", { type: "wiki_page", id: cur.id }, { from: cur.visibility, to: visibility });
    syncPageGraphLater(v, cur.id, { title: cur.title, visibility: cur.visibility, content: cur.content as DocNode });
  }
  const page = await getPage(v, slug);
  if (!page) throw new WikiError(404, "This page is no longer available to you.");
  return page;
}

/**
 * Delete a page and its history. Its source row (and the chunks read from it) go too; the page's own document node is
 * removed with its edges and their provenance, so the graph doesn't keep pointing at a page that's gone.
 */
export async function deletePage(v: Viewer, slug: string): Promise<void> {
  const cur = await readablePage(v, slug);
  if (!canDeletePage(v, cur)) {
    throw new WikiError(403, cur.visibility === "household"
      ? "Only the person who created this page or a parent can delete it."
      : "Only the person who created this page can delete it.");
  }
  cancelPendingIngest(cur.sourceId);
  await db.transaction(async (tx) => {
    await tx.delete(wikiPages).where(eq(wikiPages.id, cur.id)); // revisions cascade
    if (cur.sourceId) await tx.delete(sources).where(and(eq(sources.id, cur.sourceId), eq(sources.kind, "wiki")));
    if (cur.nodeId) {
      const [n] = await tx.select({ id: nodes.id, props: nodes.props, type: nodes.type }).from(nodes).where(eq(nodes.id, cur.nodeId));
      if (n && n.type === "document" && n.props?.wikiPageId === cur.id) {
        const edgeIds = (await tx.select({ id: edges.id }).from(edges).where(or(eq(edges.fromId, n.id), eq(edges.toId, n.id)))).map((e) => e.id);
        if (edgeIds.length) await tx.delete(provenance).where(and(eq(provenance.subjectType, "edge"), inArray(provenance.subjectId, edgeIds)));
        await tx.delete(provenance).where(and(eq(provenance.subjectType, "node"), eq(provenance.subjectId, n.id)));
        await tx.delete(nodes).where(eq(nodes.id, n.id)); // edges cascade
      }
    }
  });
  safeAudit(v, "wiki.delete", { type: "wiki_page", id: cur.id }, { title: cur.title, slug: cur.slug });
}

/* ── History ───────────────────────────────────────────────────────────────────────────────────────────── */

const revCols = {
  id: wikiRevisions.id, version: wikiRevisions.version, title: wikiRevisions.title, authorKind: wikiRevisions.authorKind,
  authorName: users.name, summary: wikiRevisions.summary, createdAt: wikiRevisions.createdAt,
};

function authorName(kind: "user" | "assistant", name: string | null) {
  return kind === "assistant" ? "Assistant" : name ?? "Someone who has left the family account";
}

export async function listRevisions(v: Viewer, slug: string, opts: { withText?: boolean; limit?: number } = {}): Promise<(WikiRevisionSummary & { contentText?: string })[]> {
  const page = await readablePage(v, slug);
  const rows = await db.select({ ...revCols, ...(opts.withText ? { contentText: wikiRevisions.contentText } : {}) })
    .from(wikiRevisions).leftJoin(users, eq(users.id, wikiRevisions.authorId))
    .where(eq(wikiRevisions.pageId, page.id))
    .orderBy(desc(wikiRevisions.version), desc(wikiRevisions.createdAt))
    .limit(Math.min(opts.limit ?? 200, 500));
  return rows.map((r) => ({ ...r, authorName: authorName(r.authorKind, r.authorName) }));
}

export async function getRevision(v: Viewer, slug: string, revisionId: string): Promise<WikiRevision | null> {
  const page = await readablePage(v, slug);
  const [r] = await db.select({ ...revCols, content: wikiRevisions.content, contentText: wikiRevisions.contentText })
    .from(wikiRevisions).leftJoin(users, eq(users.id, wikiRevisions.authorId))
    .where(and(eq(wikiRevisions.id, revisionId), eq(wikiRevisions.pageId, page.id))).limit(1);
  if (!r) return null;
  return { ...r, content: r.content as Doc, authorName: authorName(r.authorKind, r.authorName) };
}

/** Bring back an earlier version's title and text as a new revision (history is never rewritten). */
export async function restoreRevision(v: Viewer, slug: string, revisionId: string, version: number): Promise<SaveResult> {
  const rev = await getRevision(v, slug, revisionId);
  if (!rev) throw new WikiError(404, "That version of the page doesn't exist.");
  const when = rev.createdAt.toISOString().slice(0, 10);
  const res = await save(v, slug, version, {
    title: rev.title, content: sanitizeDoc(rev.content), force: false, summary: `Restored version ${rev.version} (${when})`,
  });
  safeAudit(v, "wiki.restore", { type: "wiki_page", id: res.page.id }, { revisionId, version: rev.version });
  return res;
}
