/**
 * Library reads and edits for the /library pages and /api/library routes. Server-only.
 * Every read is filtered by the viewer (see access.ts); edits and deletes are the owner's.
 */
import { and, asc, desc, eq, ilike, inArray, isNull, like, ne, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/db";
import { chunks, edges, nodes, provenance, reminders, sources, users, type Locator } from "@/db/schema";
import { audit, type Viewer } from "@/lib/auth";
import { abandonChangeSet, getChangeSet, readerT } from "@/lib/changes";
import { afterVersionDeleted } from "./revisions-store";
import type { TFn } from "@/lib/i18n/core";
import { localizeSourceTitle } from "./titles";
import * as gbrain from "@/lib/gbrain";
import { deleteStored } from "@/lib/storage";
import { liveJobsFor, type LiveJob } from "@/lib/jobs/queue";
import { canEditSourceRow, canReadSourceRow, sourceVisibleTo } from "./access";
import { IngestError } from "./errors";
import { docKindOf, type DocKind } from "./classify";
import { mimeCategory, MBOX_MIME, ZIP_MIME, type FileCategory } from "./mime";

export type Visibility = "private" | "parents" | "household";
export type SourceStatus = "pending" | "processing" | "ready" | "failed";

export type SourceSummary = {
  id: string; title: string; mime: string | null; category: FileCategory; size: number | null;
  status: SourceStatus; error: string | null; visibility: Visibility; sensitive: boolean;
  createdAt: string; ownerId: string; ownerName: string | null; isOwner: boolean;
  takenAt: string | null; extraction: string | null; warnings: string[]; startedAt: string | null;
  /** The document's own date (letter written, email sent, photo taken), and how exact it is. */
  documentDate: string | null; documentDatePrecision: string | null;
  docKind: DocKind;
  /** Mail: the conversation, and how many messages of it the viewer can see (filled by listSources). */
  threadKey: string | null; threadCount: number;
  emailFrom: string | null;
  /** What reading it proposed for the graph (a change set waiting for review), if anything. */
  changeSetId: string | null; proposedTotal: number;
  /** A message from a mail import, an attachment of an email. */
  containerId: string | null; parentSourceId: string | null;
  /** Mail imports: messages found and imported. */
  messages: number | null; imported: number | null;
  /** Its job in the reading queue, while one waits or runs (the real state behind "pending"/"processing"). */
  job: LiveJob | null;
  /** Versions: which version this is (1 = the first), and whether a newer one has replaced it. */
  revision: number; superseded: boolean;
  /** Other names the same file was uploaded under (not stored again). */
  otherNames: string[];
  /** Set on an upload that turned out to be a file already in the library (it was not kept). */
  duplicateOf: { id: string; title: string } | null;
};

/** What people filter by: the kind of file, or what the item is (mail, letter, scan, photo). */
export type LibraryType = FileCategory | "mail" | "letter" | "scan" | "photo" | "recording" | "note";
export const LIBRARY_TYPES: LibraryType[] = ["pdf", "document", "text", "image", "audio", "email", "mailbox", "other", "mail", "letter", "scan", "photo", "recording", "note"];

export type ListFilters = { category?: LibraryType; status?: SourceStatus; q?: string; thread?: string; limit?: number; offset?: number };

const LIBRARY_KINDS = ["upload", "manual", "sync", "email", "web", "connector"] as const;

const docKindSql = sql`${sources.meta}->>'docKind'`;
const isMailSql = or(eq(sources.mime, "message/rfc822"), eq(sources.kind, "email"))!;

function categoryCondition(c: LibraryType): SQL | undefined {
  switch (c) {
    case "mail": return or(isMailSql, inArray(sources.mime, [MBOX_MIME, ZIP_MIME]))!;
    case "letter": return and(or(eq(sources.mime, "application/pdf"), like(sources.mime, "%wordprocessingml%"))!, sql`coalesce(${docKindSql}, 'letter') = 'letter'`)!;
    case "scan": return sql`${docKindSql} = 'scan'`;
    case "photo": return and(like(sources.mime, "image/%"), sql`coalesce(${docKindSql}, 'photo') = 'photo'`)!;
    case "recording": return like(sources.mime, "audio/%");
    case "note": return like(sources.mime, "text/%");
    case "mailbox": return inArray(sources.mime, [MBOX_MIME, ZIP_MIME]);
    case "pdf": return eq(sources.mime, "application/pdf");
    case "document": return like(sources.mime, "%wordprocessingml%");
    case "image": return like(sources.mime, "image/%");
    case "audio": return like(sources.mime, "audio/%");
    case "text": return like(sources.mime, "text/%");
    case "email": return eq(sources.mime, "message/rfc822");
    case "other": return sql`${sources.mime} is null`;
  }
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

function summarize(r: typeof sources.$inferSelect & { ownerName: string | null }, v: Viewer, t?: TFn): SourceSummary {
  const m = r.meta ?? {};
  const exif = (m.exif ?? null) as { takenAt?: string | null } | null;
  return {
    id: r.id, title: t ? localizeSourceTitle(r, t) : r.title, mime: r.mime, category: mimeCategory(r.mime), size: r.size,
    status: r.status, error: r.error, visibility: r.visibility, sensitive: r.sensitive,
    createdAt: r.createdAt.toISOString(), ownerId: r.ownerId, ownerName: r.ownerName, isOwner: r.ownerId === v.id,
    takenAt: exif?.takenAt ?? null,
    extraction: typeof m.extraction === "string" ? m.extraction : null,
    warnings: Array.isArray(m.warnings) ? (m.warnings as unknown[]).filter((w): w is string => typeof w === "string") : [],
    startedAt: typeof m.startedAt === "string" ? m.startedAt : null,
    documentDate: r.documentDate?.toISOString() ?? null, documentDatePrecision: r.documentDatePrecision ?? null,
    docKind: typeof m.docKind === "string" ? (m.docKind as DocKind) : docKindOf({ mime: r.mime, kind: r.kind, meta: m }),
    threadKey: r.threadKey ?? null, threadCount: 0,
    emailFrom: typeof (m.email as { from?: unknown } | undefined)?.from === "string" ? (m.email as { from: string }).from : null,
    changeSetId: typeof m.changeSetId === "string" ? m.changeSetId : null,
    proposedTotal: typeof m.proposedTotal === "number" ? m.proposedTotal : 0,
    containerId: typeof m.containerId === "string" ? m.containerId : null,
    parentSourceId: typeof m.parentSourceId === "string" ? m.parentSourceId : null,
    messages: typeof m.messages === "number" ? m.messages : null,
    imported: typeof m.imported === "number" ? m.imported : null,
    job: null,
    revision: r.revision ?? 1, superseded: !!r.supersededAt,
    otherNames: Array.isArray(m.otherNames) ? (m.otherNames as unknown[]).filter((x): x is string => typeof x === "string") : [],
    duplicateOf: typeof m.duplicateOf === "string" ? { id: m.duplicateOf, title: typeof m.duplicateOfTitle === "string" ? m.duplicateOfTitle : "" } : null,
  };
}

/** Attach each source's waiting or running job. */
async function withJobs<T extends SourceSummary>(items: T[]): Promise<T[]> {
  const live = await liveJobsFor(items.filter((i) => i.status === "pending" || i.status === "processing" || i.status === "failed").map((i) => i.id)).catch(() => new Map<string, LiveJob>());
  for (const i of items) i.job = live.get(i.id) ?? null;
  return items;
}

export async function listSources(v: Viewer, f: ListFilters = {}): Promise<{ items: SourceSummary[]; total: number; dropped: SourceSummary[] }> {
  if (!(await gbrain.accessContext(v)).active) return { items: [], total: 0, dropped: [] };
  const conds: SQL[] = [sourceVisibleTo(v), inArray(sources.kind, [...LIBRARY_KINDS])];
  if (f.category) conds.push(categoryCondition(f.category)!);
  if (f.thread) conds.push(eq(sources.threadKey, f.thread));
  // A mail import's messages show under Mail, in search and in their thread; "Everything" shows the import itself.
  if (!f.category && !f.q?.trim() && !f.thread) conds.push(sql`${sources.meta}->>'containerId' is null`);
  if (f.status) conds.push(eq(sources.status, f.status));
  // Only the newest version of a document is listed; the earlier ones are on its page.
  conds.push(isNull(sources.supersededAt));
  const q = f.q?.trim();
  if (q) {
    const pat = `%${escapeLike(q)}%`;
    conds.push(or(ilike(sources.title, pat), ilike(sources.textContent, pat))!);
  }
  const where = and(...conds);
  const rows = await db
    .select({
      id: sources.id, householdId: sources.householdId, graphId: sources.graphId, ownerId: sources.ownerId, kind: sources.kind, title: sources.title,
      mime: sources.mime, storageKey: sources.storageKey, sha256: sources.sha256, size: sources.size, textContent: sql<string | null>`null`,
      meta: sources.meta, status: sources.status, error: sources.error, visibility: sources.visibility, sensitive: sources.sensitive,
      nodeId: sources.nodeId, documentDate: sources.documentDate, documentDatePrecision: sources.documentDatePrecision, threadKey: sources.threadKey,
      url: sources.url, externalId: sources.externalId, connectionId: sources.connectionId, fetchedAt: sources.fetchedAt,
      lineageId: sources.lineageId, revision: sources.revision, supersededAt: sources.supersededAt, docKey: sources.docKey,
      nameKey: sources.nameKey, contentKey: sources.contentKey, createdAt: sources.createdAt, ownerName: users.name,
    })
    .from(sources)
    .leftJoin(users, eq(users.id, sources.ownerId))
    .where(where)
    .orderBy(desc(sources.createdAt))
    .limit(Math.min(f.limit ?? 60, 200))
    .offset(f.offset ?? 0);
  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(sources).where(where);
  const t = await readerT(v);
  const items = await withJobs(rows.map((r) => summarize(r, v, t)));
  const keys = [...new Set(items.map((i) => i.threadKey).filter((k): k is string => !!k))];
  if (keys.length) {
    const counts = await db.select({ key: sources.threadKey, n: sql<number>`count(*)::int` }).from(sources)
      .where(and(sourceVisibleTo(v), inArray(sources.threadKey, keys), isMailSql)).groupBy(sources.threadKey);
    const byKey = new Map(counts.map((c) => [c.key, c.n]));
    for (const i of items) if (i.threadKey) i.threadCount = byKey.get(i.threadKey) ?? 1;
  }
  // My uploads of the last hour that turned out to be files I already had (for the upload screen's message).
  const droppedRows = await db.select().from(sources).where(and(
    eq(sources.graphId, v.graphId), eq(sources.ownerId, v.id), sql`${sources.meta}->>'duplicateOf' is not null`,
    sql`${sources.createdAt} > now() - interval '1 hour'`,
  )).orderBy(desc(sources.createdAt)).limit(50);
  const dropped = droppedRows.map((r) => summarize({ ...r, ownerName: null }, v, t));
  return { items, total: count, dropped };
}

/** Load a source the viewer may read, or null. */
export async function getReadableSource(v: Viewer, id: string) {
  if (!(await gbrain.accessContext(v)).active) return null; // an expired guest sees nothing
  const [row] = await db.select({ s: sources, ownerName: users.name }).from(sources).leftJoin(users, eq(users.id, sources.ownerId)).where(eq(sources.id, id)).limit(1);
  if (!row) return null;
  let shared = false;
  if (row.s.nodeId && row.s.ownerId !== v.id) {
    const s = await db.execute<{ ok: number }>(sql`select 1 as ok from shares where node_id = ${row.s.nodeId} and user_id = ${v.id} and (expires_at is null or expires_at > now()) limit 1`);
    shared = s.length > 0;
  }
  return canReadSourceRow(v, row.s, shared) ? { ...row.s, ownerName: row.ownerName } : null;
}

export type ExtractedFact = {
  edgeId: string; relation: string; status: string; confidence: number; quote: string | null; locator: Locator; chunkId: string | null;
  from: { id: string; label: string; type: string }; to: { id: string; label: string; type: string };
};
export type ExtractedEntity = { id: string; label: string; type: string; summary: string | null; startAt: string | null };

export type SourceDetail = {
  /** hasFile: an original is stored (pasted notes and web pages have only their text). */
  source: SourceSummary & { textContent: string | null; meta: Record<string, unknown>; nodeId: string | null; hasFile: boolean };
  chunks: { id: string; idx: number; text: string; locator: Locator }[];
  entities: ExtractedEntity[];
  facts: ExtractedFact[];
  /** Mail: the other messages of the conversation the viewer can open, oldest first. */
  thread: { key: string; messages: { id: string; title: string; at: string; from: string | null }[] } | null;
  /** What reading it proposed: the change set, its state, and what is in it. */
  proposal: { changeSetId: string | null; total: number; counts: Record<string, number>; status: "draft" | "delivered" | "abandoned" | "waiting" | null } | null;
  attachments: { id: string; title: string }[];
  parent: { id: string; title: string } | null;
  /** Mail imports: their messages, newest first (a page). */
  importedMessages: { id: string; title: string; at: string | null }[];
  /** Every version of this document the viewer may read, newest first (one entry when there is only this one). */
  versions: { id: string; title: string; revision: number; createdAt: string; current: boolean; size: number | null }[];
};

export async function getSourceDetail(v: Viewer, id: string): Promise<SourceDetail | null> {
  const src = await getReadableSource(v, id);
  if (!src) return null;

  const chunkRows = await db.select({ id: chunks.id, idx: chunks.idx, text: chunks.text, locator: chunks.locator })
    .from(chunks).where(eq(chunks.sourceId, id)).orderBy(asc(chunks.idx));

  const fromN = alias(nodes, "from_n");
  const toN = alias(nodes, "to_n");
  const factRows = await db.select({
    edgeId: edges.id, relation: edges.relation, status: edges.status, edgeOwner: edges.ownerId, edgeHousehold: edges.householdId, edgeVisibility: edges.visibility,
    confidence: provenance.confidence, quote: provenance.quote, locator: provenance.locator, chunkId: provenance.chunkId,
    fromId: fromN.id, fromLabel: fromN.label, fromType: fromN.type, fromSensitive: fromN.sensitive,
    toId: toN.id, toLabel: toN.label, toType: toN.type, toSensitive: toN.sensitive,
  })
    .from(provenance)
    .innerJoin(edges, and(eq(provenance.subjectType, "edge"), eq(edges.id, provenance.subjectId)))
    .innerJoin(fromN, eq(fromN.id, edges.fromId))
    .innerJoin(toN, eq(toN.id, edges.toId))
    .where(and(eq(provenance.sourceId, id), ne(edges.relation, "mentions"), ne(edges.status, "rejected"), ne(edges.status, "superseded")))
    .orderBy(desc(provenance.confidence));

  // A fact is shown only when GBrain says the viewer may read it (the edge and both ends: owner, visibility, shares,
  // children + sensitive) — reading a file must not reveal facts about people the viewer can't see.
  const readableEdges = await gbrain.readableEdgeIds(v, factRows.map((r) => r.edgeId));
  const facts = new Map<string, ExtractedFact>();
  for (const r of factRows) {
    if (facts.has(r.edgeId)) continue;
    if (!readableEdges.has(r.edgeId)) continue;
    facts.set(r.edgeId, {
      edgeId: r.edgeId, relation: r.relation, status: r.status, confidence: r.confidence, quote: r.quote, locator: r.locator ?? {}, chunkId: r.chunkId,
      from: { id: r.fromId, label: r.fromLabel, type: r.fromType }, to: { id: r.toId, label: r.toLabel, type: r.toType },
    });
  }

  // Entities: nodes this document mentions (edges from the document node) plus nodes whose provenance cites the source.
  const entityRows = await db.selectDistinctOn([nodes.id], {
    id: nodes.id, label: nodes.label, type: nodes.type, summary: nodes.summary, startAt: nodes.startAt,
    ownerId: nodes.ownerId, householdId: nodes.householdId, visibility: nodes.visibility, sensitive: nodes.sensitive,
  })
    .from(nodes)
    .where(and(
      sql`${nodes.mergedInto} is null`,
      ne(nodes.type, "document"),
      or(
        src.nodeId ? sql`${nodes.id} in (select to_id from edges where from_id = ${src.nodeId} and relation = 'mentions')` : sql`false`,
        sql`${nodes.id} in (select subject_id from provenance where subject_type = 'node' and source_id = ${id})`,
      ),
    ));
  const readableEntities = await gbrain.readableNodeIds(v, entityRows.map((n) => n.id));
  const entities = entityRows
    .filter((n) => readableEntities.has(n.id))
    .map((n) => ({ id: n.id, label: n.label, type: n.type, summary: n.summary, startAt: n.startAt?.toISOString() ?? null }))
    .sort((a, b) => a.type.localeCompare(b.type) || a.label.localeCompare(b.label));

  const t = await readerT(v);
  const [summary] = await withJobs([summarize({ ...src, ownerName: src.ownerName }, v, t)]);
  const m = src.meta ?? {};

  let thread: SourceDetail["thread"] = null;
  if (src.threadKey) {
    const msgs = await db.select({ id: sources.id, title: sources.title, at: sql<Date>`coalesce(${sources.documentDate}, ${sources.createdAt})`, meta: sources.meta })
      .from(sources).where(and(sourceVisibleTo(v), eq(sources.threadKey, src.threadKey), isMailSql))
      .orderBy(asc(sql`coalesce(${sources.documentDate}, ${sources.createdAt})`)).limit(200);
    if (msgs.length > 1) {
      thread = { key: src.threadKey, messages: msgs.map((x) => ({ id: x.id, title: localizeSourceTitle(x, t), at: new Date(x.at).toISOString(), from: ((x.meta ?? {}).email as { from?: string | null } | undefined)?.from ?? null })) };
    }
  }
  const attachments = await db.select({ id: sources.id, title: sources.title }).from(sources)
    .where(and(sourceVisibleTo(v), sql`${sources.meta}->>'parentSourceId' = ${id}`)).limit(50);
  const parentId = typeof m.parentSourceId === "string" ? m.parentSourceId : null;
  const parentRow = parentId ? await db.select({ id: sources.id, title: sources.title }).from(sources).where(and(sourceVisibleTo(v), eq(sources.id, parentId))).limit(1) : [];
  const importedMessages = src.mime === MBOX_MIME || src.mime === ZIP_MIME
    ? (await db.select({ id: sources.id, title: sources.title, at: sources.documentDate }).from(sources)
      .where(and(sourceVisibleTo(v), sql`${sources.meta}->>'containerId' = ${id}`)).orderBy(desc(sources.documentDate)).limit(100))
      .map((x) => ({ id: x.id, title: x.title, at: x.at?.toISOString() ?? null }))
    : [];

  const lineage = src.lineageId ?? src.id;
  const versions = (await db.select({ id: sources.id, title: sources.title, revision: sources.revision, createdAt: sources.createdAt, supersededAt: sources.supersededAt, size: sources.size })
    .from(sources).where(and(sourceVisibleTo(v), sql`coalesce(${sources.lineageId}, ${sources.id}) = ${lineage}`))
    .orderBy(desc(sources.revision), desc(sources.createdAt)).limit(100))
    .map((x) => ({ id: x.id, title: x.title, revision: x.revision, createdAt: x.createdAt.toISOString(), current: !x.supersededAt, size: x.size }));

  let proposal: SourceDetail["proposal"] = null;
  const csId = typeof m.changeSetId === "string" ? m.changeSetId : null;
  const total = typeof m.proposedTotal === "number" ? m.proposedTotal : 0;
  if (csId || total > 0) {
    let status: NonNullable<SourceDetail["proposal"]>["status"] = csId ? null : "waiting";
    if (csId) {
      try { status = (await getChangeSet(v, csId))?.status ?? null; } catch { status = null; }
    }
    proposal = { changeSetId: csId, total, counts: (m.proposed ?? {}) as Record<string, number>, status };
  }

  return {
    source: { ...summary, textContent: src.textContent, meta: m, nodeId: src.nodeId, hasFile: !!src.storageKey },
    chunks: chunkRows.map((c) => ({ ...c, locator: c.locator ?? {} })),
    entities,
    facts: [...facts.values()],
    thread, proposal, attachments, parent: parentRow[0] ?? null, importedMessages, versions,
  };
}

export async function updateSource(v: Viewer, id: string, patch: { title?: string; visibility?: Visibility; sensitive?: boolean }): Promise<SourceSummary> {
  const src = await getReadableSource(v, id);
  if (!src) throw new IngestError(404, "This file doesn't exist or you don't have access to it.");
  if (!canEditSourceRow(v, src)) throw new IngestError(403, "Only the person who added this file can change it.");
  const set: Partial<typeof sources.$inferInsert> = {};
  if (patch.title !== undefined) {
    set.title = patch.title;
    // Their own words now: a title My Graph wrote (and showed in each reader's language) no longer applies.
    if (typeof (src.meta ?? {}).titleKey === "string") {
      const { titleKey: _k, titleParams: _p, ...rest } = src.meta ?? {};
      void _k; void _p;
      set.meta = rest;
    }
  }
  if (patch.visibility !== undefined) set.visibility = patch.visibility;
  if (patch.sensitive !== undefined) set.sensitive = patch.sensitive;
  if (Object.keys(set).length === 0) return summarize({ ...src }, v);
  const [row] = await db.update(sources).set(set).where(eq(sources.id, id)).returning();

  // Keep the document node in step (label, who can see it).
  if (src.nodeId) {
    try {
      await gbrain.updateNode(v, src.nodeId, {
        ...(patch.title !== undefined ? { label: patch.title } : {}),
        ...(patch.visibility !== undefined ? { visibility: patch.visibility } : {}),
        ...(patch.sensitive !== undefined ? { sensitive: patch.sensitive } : {}),
      }, { sourceId: id, activity: "manual_edit", agentType: "user", agentId: v.id, note: "Library settings changed" });
    } catch (e) {
      console.warn("[library] could not update document node", e);
    }
  }
  void audit(v, "library.update", { type: "source", id }, { ...patch }).catch(() => {});
  return summarize({ ...row, ownerName: src.ownerName }, v);
}

export async function deleteSource(v: Viewer, id: string): Promise<{ fileRemoved: boolean }> {
  const src = await getReadableSource(v, id);
  if (!src) throw new IngestError(404, "This file doesn't exist or you don't have access to it.");
  if (!canEditSourceRow(v, src)) throw new IngestError(403, "Only the person who added this file can delete it.");

  await db.transaction(async (tx) => {
    // Assistant reminders that came from this file go with it; anything a person wrote stays.
    await tx.delete(reminders).where(and(eq(reminders.sourceId, id), eq(reminders.createdByKind, "assistant"), eq(reminders.done, false)));
    await tx.delete(sources).where(eq(sources.id, id)); // chunks cascade; provenance.source_id is set null
    if (src.nodeId) {
      // The file's own document node (and its "mentions" edges) is removed; extracted people/places/events stay,
      // because other sources may support them.
      await tx.delete(nodes).where(and(eq(nodes.id, src.nodeId), eq(nodes.type, "document"), eq(nodes.ownerId, v.id)));
    }
  });

  let fileRemoved = false;
  if (src.storageKey) {
    const [other] = await db.select({ id: sources.id }).from(sources).where(eq(sources.storageKey, src.storageKey)).limit(1);
    if (!other) {
      await deleteStored(src.storageKey);
      fileRemoved = true;
    }
  }
  // The newest version left becomes the current one; what this file proposed and nobody decided on goes with it.
  if (src.lineageId || !src.supersededAt) await afterVersionDeleted(src.graphId, src.lineageId ?? null).catch(() => {});
  const csId = typeof src.meta?.changeSetId === "string" ? src.meta.changeSetId : null;
  if (csId) {
    const cs = await getChangeSet(v, csId).catch(() => null);
    if (cs?.status === "draft") await abandonChangeSet(v, csId).catch(() => false);
  }
  void audit(v, "library.delete", { type: "source", id }, { title: src.title, fileRemoved }).catch(() => {});
  return { fileRemoved };
}
