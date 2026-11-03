/** Direct reads for the Today page (children, facts to check, failed uploads, recent items). Server-only. */
import { and, count, desc, eq, gte, inArray, isNull, lt, ne, notInArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/db";
import { edges, nodes, provenance, sources, users, wikiPages } from "@/db/schema";
import type { Viewer } from "@/lib/auth";
import { canSeeItem, visibleChildren } from "./access";
import { humanizeRelation } from "./context";
import { visibleWhere } from "./sql";

export type ChildRow = { id: string; name: string; birthYear: number | null; personNodeId: string | null; personLabel: string | null };

/** Children in the household the viewer gets a card for (parents: all; a child: themself; guests: none). */
export async function loadChildren(v: Viewer): Promise<ChildRow[]> {
  if (v.role === "guest") return [];
  const rows = await db.select({
    id: users.id, name: users.name, birthYear: users.birthYear, personNodeId: users.personNodeId, personLabel: nodes.label,
  }).from(users)
    .leftJoin(nodes, eq(nodes.id, users.personNodeId))
    .where(and(eq(users.householdId, v.householdId), eq(users.role, "child")))
    .orderBy(users.birthYear, users.name);
  return visibleChildren(v, rows);
}

export type AttentionFact = {
  edgeId: string; fromId: string; fromLabel: string; fromType: string; toId: string; toLabel: string; toType: string;
  relation: string; text: string; confidence: number; createdAt: Date; sensitive: boolean;
  sourceId: string | null; sourceTitle: string | null; quote: string | null; page: number | null;
};

/** Unconfirmed facts with confidence below `maxConfidence` extracted in the last `days` days, newest first. */
export async function loadAttentionFacts(v: Viewer, opts: { days?: number; limit?: number; maxConfidence?: number; now?: Date } = {}): Promise<{ facts: AttentionFact[]; total: number }> {
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - (opts.days ?? 14) * 86_400_000);
  const fromN = alias(nodes, "from_n");
  const toN = alias(nodes, "to_n");
  const where = and(
    visibleWhere(v, edges),
    eq(edges.status, "unconfirmed"),
    lt(edges.confidence, opts.maxConfidence ?? 0.6),
    gte(edges.createdAt, since),
    visibleWhere(v, { ownerId: fromN.ownerId, householdId: fromN.householdId, visibility: fromN.visibility, sensitive: fromN.sensitive }),
    visibleWhere(v, { ownerId: toN.ownerId, householdId: toN.householdId, visibility: toN.visibility, sensitive: toN.sensitive }),
    isNull(fromN.mergedInto),
    isNull(toN.mergedInto),
  );
  const [rows, [{ total }]] = await Promise.all([
    db.select({
      edgeId: edges.id, relation: edges.relation, confidence: edges.confidence, createdAt: edges.createdAt,
      fromId: fromN.id, fromLabel: fromN.label, fromType: fromN.type, fromSensitive: fromN.sensitive,
      toId: toN.id, toLabel: toN.label, toType: toN.type, toSensitive: toN.sensitive,
    }).from(edges)
      .innerJoin(fromN, eq(fromN.id, edges.fromId))
      .innerJoin(toN, eq(toN.id, edges.toId))
      .where(where)
      .orderBy(desc(edges.createdAt))
      .limit(opts.limit ?? 5),
    db.select({ total: count() }).from(edges)
      .innerJoin(fromN, eq(fromN.id, edges.fromId))
      .innerJoin(toN, eq(toN.id, edges.toId))
      .where(where),
  ]);
  if (!rows.length) return { facts: [], total };

  const provRows = await db.select({
    subjectId: provenance.subjectId, sourceId: provenance.sourceId, quote: provenance.quote, locator: provenance.locator,
    sourceTitle: sources.title, sourceOwnerId: sources.ownerId, sourceHouseholdId: sources.householdId, sourceVisibility: sources.visibility,
    sourceSensitive: sources.sensitive,
  }).from(provenance)
    .leftJoin(sources, eq(sources.id, provenance.sourceId))
    .where(and(eq(provenance.subjectType, "edge"), inArray(provenance.subjectId, rows.map((r) => r.edgeId))))
    .orderBy(desc(provenance.createdAt));
  const firstProv = new Map<string, (typeof provRows)[number]>();
  for (const p of provRows) if (!firstProv.has(p.subjectId)) firstProv.set(p.subjectId, p);

  const facts = rows.map((r): AttentionFact => {
    const p = firstProv.get(r.edgeId);
    // Only show the source title if the viewer could open that source.
    const sourceVisible = Boolean(p?.sourceId && p.sourceOwnerId && p.sourceHouseholdId && p.sourceVisibility
      && canSeeItem(v, { ownerId: p.sourceOwnerId, householdId: p.sourceHouseholdId, visibility: p.sourceVisibility, sensitive: p.sourceSensitive ?? false }));
    return {
      edgeId: r.edgeId, fromId: r.fromId, fromLabel: r.fromLabel, fromType: r.fromType, toId: r.toId, toLabel: r.toLabel, toType: r.toType,
      relation: r.relation, text: `${r.fromLabel} ${humanizeRelation(r.relation)} ${r.toLabel}`,
      confidence: r.confidence, createdAt: r.createdAt, sensitive: r.fromSensitive || r.toSensitive,
      sourceId: sourceVisible ? p!.sourceId : null, sourceTitle: sourceVisible ? p!.sourceTitle : null,
      quote: sourceVisible ? p!.quote ?? null : null, page: sourceVisible ? p!.locator?.page ?? null : null,
    };
  });
  return { facts, total };
}

export type SourceRow = { id: string; title: string; kind: string; mime: string | null; status: string; error: string | null; createdAt: Date; sensitive: boolean };

const sourceCols = {
  id: sources.id, title: sources.title, kind: sources.kind, mime: sources.mime, status: sources.status,
  error: sources.error, createdAt: sources.createdAt, sensitive: sources.sensitive,
};

/** The viewer's own uploads that failed (they're the one who can retry them). */
export async function loadFailedUploads(v: Viewer, limit = 5): Promise<{ items: SourceRow[]; total: number }> {
  const where = and(eq(sources.householdId, v.householdId), eq(sources.ownerId, v.id), eq(sources.status, "failed"));
  const [items, [{ total }]] = await Promise.all([
    db.select(sourceCols).from(sources).where(where).orderBy(desc(sources.createdAt)).limit(limit),
    db.select({ total: count() }).from(sources).where(where),
  ]);
  return { items, total };
}

/** Latest files and notes the viewer can see (wiki and chat sources are shown elsewhere). */
export async function loadRecentSources(v: Viewer, limit = 5): Promise<SourceRow[]> {
  return db.select(sourceCols).from(sources)
    .where(and(visibleWhere(v, { ownerId: sources.ownerId, householdId: sources.householdId, visibility: sources.visibility, sensitive: sources.sensitive }), notInArray(sources.kind, ["wiki", "chat"]), ne(sources.status, "failed")))
    .orderBy(desc(sources.createdAt))
    .limit(limit);
}

export type WikiRow = { id: string; slug: string; title: string; updatedAt: Date };

export async function loadRecentWikiPages(v: Viewer, limit = 5): Promise<WikiRow[]> {
  return db.select({ id: wikiPages.id, slug: wikiPages.slug, title: wikiPages.title, updatedAt: wikiPages.updatedAt })
    .from(wikiPages)
    .where(visibleWhere(v, wikiPages))
    .orderBy(desc(wikiPages.updatedAt))
    .limit(limit);
}
