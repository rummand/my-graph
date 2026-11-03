/**
 * Library reads and edits for the /library pages and /api/library routes. Server-only.
 * Every read is filtered by the viewer (see access.ts); edits and deletes are the owner's.
 */
import { and, asc, desc, eq, ilike, inArray, like, ne, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/db";
import { chunks, edges, nodes, provenance, reminders, sources, users, type Locator } from "@/db/schema";
import { audit, type Viewer } from "@/lib/auth";
import * as gbrain from "@/lib/gbrain";
import { deleteStored } from "@/lib/storage";
import { canEditSourceRow, canReadSourceRow, sourceVisibleTo } from "./access";
import { IngestError } from "./errors";
import { mimeCategory, type FileCategory } from "./mime";

export type Visibility = "private" | "parents" | "household";
export type SourceStatus = "pending" | "processing" | "ready" | "failed";

export type SourceSummary = {
  id: string; title: string; mime: string | null; category: FileCategory; size: number | null;
  status: SourceStatus; error: string | null; visibility: Visibility; sensitive: boolean;
  createdAt: string; ownerId: string; ownerName: string | null; isOwner: boolean;
  takenAt: string | null; extraction: string | null; warnings: string[]; startedAt: string | null;
};

export type ListFilters = { category?: FileCategory; status?: SourceStatus; q?: string; limit?: number; offset?: number };

const LIBRARY_KINDS = ["upload", "manual", "sync"] as const;

function categoryCondition(c: FileCategory): SQL | undefined {
  switch (c) {
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

function summarize(r: typeof sources.$inferSelect & { ownerName: string | null }, v: Viewer): SourceSummary {
  const m = r.meta ?? {};
  const exif = (m.exif ?? null) as { takenAt?: string | null } | null;
  return {
    id: r.id, title: r.title, mime: r.mime, category: mimeCategory(r.mime), size: r.size,
    status: r.status, error: r.error, visibility: r.visibility, sensitive: r.sensitive,
    createdAt: r.createdAt.toISOString(), ownerId: r.ownerId, ownerName: r.ownerName, isOwner: r.ownerId === v.id,
    takenAt: exif?.takenAt ?? null,
    extraction: typeof m.extraction === "string" ? m.extraction : null,
    warnings: Array.isArray(m.warnings) ? (m.warnings as unknown[]).filter((w): w is string => typeof w === "string") : [],
    startedAt: typeof m.startedAt === "string" ? m.startedAt : null,
  };
}

export async function listSources(v: Viewer, f: ListFilters = {}): Promise<{ items: SourceSummary[]; total: number }> {
  if (!(await gbrain.accessContext(v)).active) return { items: [], total: 0 };
  const conds: SQL[] = [sourceVisibleTo(v), inArray(sources.kind, [...LIBRARY_KINDS])];
  if (f.category) conds.push(categoryCondition(f.category)!);
  if (f.status) conds.push(eq(sources.status, f.status));
  const q = f.q?.trim();
  if (q) {
    const pat = `%${escapeLike(q)}%`;
    conds.push(or(ilike(sources.title, pat), ilike(sources.textContent, pat))!);
  }
  const where = and(...conds);
  const rows = await db
    .select({
      id: sources.id, householdId: sources.householdId, ownerId: sources.ownerId, kind: sources.kind, title: sources.title,
      mime: sources.mime, storageKey: sources.storageKey, sha256: sources.sha256, size: sources.size, textContent: sql<string | null>`null`,
      meta: sources.meta, status: sources.status, error: sources.error, visibility: sources.visibility, sensitive: sources.sensitive,
      nodeId: sources.nodeId, createdAt: sources.createdAt, ownerName: users.name,
    })
    .from(sources)
    .leftJoin(users, eq(users.id, sources.ownerId))
    .where(where)
    .orderBy(desc(sources.createdAt))
    .limit(Math.min(f.limit ?? 60, 200))
    .offset(f.offset ?? 0);
  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(sources).where(where);
  return { items: rows.map((r) => summarize(r, v)), total: count };
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
  source: SourceSummary & { textContent: string | null; meta: Record<string, unknown>; nodeId: string | null };
  chunks: { id: string; idx: number; text: string; locator: Locator }[];
  entities: ExtractedEntity[];
  facts: ExtractedFact[];
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

  const summary = summarize({ ...src, ownerName: src.ownerName }, v);
  return {
    source: { ...summary, textContent: src.textContent, meta: src.meta ?? {}, nodeId: src.nodeId },
    chunks: chunkRows.map((c) => ({ ...c, locator: c.locator ?? {} })),
    entities,
    facts: [...facts.values()],
  };
}

export async function updateSource(v: Viewer, id: string, patch: { title?: string; visibility?: Visibility; sensitive?: boolean }): Promise<SourceSummary> {
  const src = await getReadableSource(v, id);
  if (!src) throw new IngestError(404, "This file doesn't exist or you don't have access to it.");
  if (!canEditSourceRow(v, src)) throw new IngestError(403, "Only the person who added this file can change it.");
  const set: Partial<typeof sources.$inferInsert> = {};
  if (patch.title !== undefined) set.title = patch.title;
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
  void audit(v, "library.delete", { type: "source", id }, { title: src.title, fileRemoved }).catch(() => {});
  return { fileRemoved };
}
