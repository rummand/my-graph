/**
 * Versions of a document in the library (server-only; the pure rules are in revisions.ts).
 *
 *   The same bytes again                  → not stored (ingestFile); the other name is remembered on the original.
 *   The same text again (renamed, saved)  → dropped once read; the other name is remembered on the original.
 *   A new version (same document id, or   → kept as the next revision of that document; the earlier ones stay, marked
 *   the same name and much the same text)   superseded, and the library shows the newest.
 *
 * Only the uploader's own files are compared, in the current graph: another person's private file must never be
 * revealed by "you already have this".
 */
import { and, desc, eq, isNull, ne, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { sources } from "@/db/schema";
import { NAME_MATCH_SIMILARITY, contentKeyOf, textSimilarity } from "./revisions";

type Src = typeof sources.$inferSelect;

export type Settled =
  | { outcome: "duplicate"; of: { id: string; title: string } }
  | { outcome: "revision"; lineageId: string; revision: number; of: { id: string; title: string } }
  | { outcome: "new" };

const DAY = 86_400_000;

/** Remember another name a file was uploaded under (shown on the file's page). */
export async function rememberName(id: string, name: string): Promise<void> {
  await db.update(sources).set({
    meta: sql`jsonb_set(${sources.meta}, '{otherNames}', (
      select coalesce(jsonb_agg(distinct x), '[]'::jsonb) from jsonb_array_elements_text(coalesce(${sources.meta}->'otherNames', '[]'::jsonb) || to_jsonb(${name}::text)) x
    ))`,
  }).where(and(eq(sources.id, id), ne(sources.title, name)));
}

/** The newest version of each candidate lineage (or lone file) of this owner in this graph matching `where`. */
async function latestMatching(src: Src, where: SQL, opts: { anyVersion?: boolean } = {}) {
  return db.select().from(sources).where(and(
    eq(sources.graphId, src.graphId), eq(sources.ownerId, src.ownerId), ne(sources.id, src.id),
    opts.anyVersion ? sql`${sources.meta}->>'duplicateOf' is null` : isNull(sources.supersededAt),
    sql`${sources.status} <> 'failed'`, eq(sources.mime, src.mime ?? ""), where,
  )).orderBy(desc(sources.createdAt)).limit(5);
}

/**
 * Called by the pipeline once the text is read, before anything is indexed or proposed. Decides whether `src` is a
 * duplicate (the caller then drops it), a new version of an earlier file (recorded here), or a document of its own.
 */
export async function settleRevision(src: Src, textContent: string): Promise<Settled> {
  if (!src.storageKey || src.kind === "email" || src.connectionId) return { outcome: "new" };
  const contentKey = contentKeyOf(textContent);
  if (contentKey !== src.contentKey) await db.update(sources).set({ contentKey }).where(eq(sources.id, src.id));

  // 1. The same text as a file of mine: the same document under another name. Drop this one.
  if (contentKey) {
    // Any version counts: a renamed copy of version 1 is a file we already have, even after version 2 came.
    const [same] = await latestMatching(src, eq(sources.contentKey, contentKey), { anyVersion: true });
    if (same) return { outcome: "duplicate", of: { id: same.id, title: same.title } };
  }

  // 2. A version: the same document id (strong), else the same name with much the same text (weak).
  let prev: Src | null = null;
  if (src.docKey) [prev = null] = await latestMatching(src, eq(sources.docKey, src.docKey));
  if (!prev && src.nameKey) {
    for (const cand of await latestMatching(src, eq(sources.nameKey, src.nameKey))) {
      const sim = textSimilarity(textContent, cand.textContent ?? "");
      // Monthly letters with the same name and template are separate documents: far-apart dates need more alike text.
      const apart = src.documentDate && cand.documentDate && Math.abs(src.documentDate.getTime() - cand.documentDate.getTime()) > 60 * DAY;
      if (sim >= (apart ? 0.8 : NAME_MATCH_SIMILARITY)) { prev = cand; break; }
    }
  }
  if (!prev) return { outcome: "new" };

  const { lineageId, revision } = await appendRevision(src, prev);
  return { outcome: "revision", lineageId, revision, of: { id: prev.id, title: prev.title } };
}

/**
 * Record `src` as the next version of the document `prev` belongs to: the lineage is `prev`'s (its first version's
 * id), `src` gets the next revision number, and every earlier version is marked superseded. Both must be the same
 * owner's files in the same graph (callers check; the pipeline's settleRevision, the Mac app's file door).
 */
export async function appendRevision(src: Pick<Src, "id" | "graphId" | "ownerId">, prev: Pick<Src, "id" | "graphId" | "ownerId" | "lineageId">): Promise<{ lineageId: string; revision: number }> {
  if (src.graphId !== prev.graphId || src.ownerId !== prev.ownerId) throw new Error("A version must be the same person's file in the same graph.");
  const lineageId = prev.lineageId ?? prev.id;
  const revision = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`mygraph:lineage:${lineageId}`}))`);
    const [{ max }] = await tx.select({ max: sql<number>`coalesce(max(${sources.revision}), 1)` }).from(sources)
      .where(and(eq(sources.graphId, src.graphId), sql`coalesce(${sources.lineageId}, ${sources.id}) = ${lineageId}`));
    const next = Number(max) + 1;
    await tx.update(sources).set({ lineageId }).where(and(eq(sources.id, prev.id), isNull(sources.lineageId)));
    await tx.update(sources).set({ supersededAt: new Date() })
      .where(and(eq(sources.graphId, src.graphId), sql`coalesce(${sources.lineageId}, ${sources.id}) = ${lineageId}`, isNull(sources.supersededAt), ne(sources.id, src.id)));
    await tx.update(sources).set({ lineageId, revision: next, supersededAt: null }).where(eq(sources.id, src.id));
    return next;
  });
  return { lineageId, revision };
}

/** When a version is deleted, the newest one left becomes the current one again. */
export async function afterVersionDeleted(graphId: string, lineageId: string | null): Promise<void> {
  if (!lineageId) return;
  const [newest] = await db.select({ id: sources.id }).from(sources)
    .where(and(eq(sources.graphId, graphId), sql`coalesce(${sources.lineageId}, ${sources.id}) = ${lineageId}`))
    .orderBy(desc(sources.revision), desc(sources.createdAt)).limit(1);
  if (newest) await db.update(sources).set({ supersededAt: null }).where(eq(sources.id, newest.id));
}

export type VersionRow = { id: string; title: string; revision: number; createdAt: Date; current: boolean; size: number | null };

/** Every version of the document `id` belongs to, newest first (only the owner's own files). */
export async function versionsOf(src: Pick<Src, "id" | "graphId" | "lineageId">): Promise<VersionRow[]> {
  const lineage = src.lineageId ?? src.id;
  const rows = await db.select({ id: sources.id, title: sources.title, revision: sources.revision, createdAt: sources.createdAt, supersededAt: sources.supersededAt, size: sources.size })
    .from(sources).where(and(eq(sources.graphId, src.graphId), sql`coalesce(${sources.lineageId}, ${sources.id}) = ${lineage}`))
    .orderBy(desc(sources.revision), desc(sources.createdAt));
  return rows.map((r) => ({ id: r.id, title: r.title, revision: r.revision, createdAt: r.createdAt, current: !r.supersededAt, size: r.size }));
}
