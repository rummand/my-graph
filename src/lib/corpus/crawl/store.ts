/**
 * Crawled documents into the library (server-only). Each page or PDF the crawler read becomes a source in the rule
 * set's graph — kind "web", its address, when it was fetched, its text with passages (character locators; PDFs per
 * page) — and is linked to the rule set with its role. Read again later ("Check for changes"): the same words → the
 * source is only marked checked; changed words → a new version of that source (the library's versions), the old one
 * kept as the earlier version, and the rule set now points at the new one.
 */
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { chunks, corpusSources, sources } from "@/db/schema";
import type { Viewer } from "@/lib/auth";
import { putFile, sha256Hex } from "@/lib/storage";
import { chunkSegments, type TextSegment } from "@/lib/ingest/chunk";
import { contentKeyOf } from "@/lib/ingest/revisions";
import { appendRevision } from "@/lib/ingest/revisions-store";
import { chunkPage, webTitle } from "@/lib/web/pure";
import type { CrawlDoc } from "./engine";
import type { SourceRole } from "../pure";

export type Stored = { sourceId: string; status: "new" | "changed" | "unchanged"; previousId: string | null; pages: number | null };

/** Text and passages of a crawled document (PDFs are read page by page). */
async function readDoc(doc: CrawlDoc, v: Viewer): Promise<{ text: string; segments: TextSegment[]; pages: number | null; warnings: string[] }> {
  if (doc.format !== "pdf" || !doc.bytes) {
    const text = doc.text ?? "";
    return { text, segments: [], pages: null, warnings: [] };
  }
  const { extractPdf } = await import("@/lib/ingest/formats/pdf");
  const mux = await import("@/lib/mux");
  const muxUp = await mux.muxHealth().then((h) => h.ok).catch(() => false);
  const ex = await extractPdf({ bytes: Buffer.from(doc.bytes), sensitive: false, muxUp, muxMeta: { userId: v.id, agent: "my-graph:rule-crawler", graphId: v.graphId } });
  return { text: ex.textContent.replace(/­/g, ""), segments: ex.segments, pages: typeof ex.meta.pages === "number" ? (ex.meta.pages as number) : null, warnings: ex.warnings };
}

/** The rule set's current source for this address (the newest version), if it has one. */
async function currentFor(v: Viewer, corpusId: string, url: string) {
  const [row] = await db.select({ id: sources.id, contentKey: sources.contentKey, lineageId: sources.lineageId, graphId: sources.graphId, ownerId: sources.ownerId, meta: sources.meta, linkId: corpusSources.id, role: corpusSources.role })
    .from(corpusSources).innerJoin(sources, eq(sources.id, corpusSources.sourceId))
    .where(and(eq(corpusSources.corpusId, corpusId), eq(corpusSources.graphId, v.graphId), eq(sources.url, url), isNull(sources.supersededAt))).limit(1);
  return row ?? null;
}

export async function storeDoc(v: Viewer, corpusId: string, doc: CrawlDoc): Promise<Stored> {
  const read = await readDoc(doc, v);
  const contentKey = contentKeyOf(read.text) ?? `bytes:${doc.bytes ? sha256Hex(doc.bytes) : ""}`;
  const prior = await currentFor(v, corpusId, doc.url);
  const fetchedAt = new Date();
  if (prior && prior.contentKey === contentKey) {
    await db.update(sources).set({ fetchedAt, meta: sql`jsonb_set(${sources.meta}, '{crawl,checkedAt}', to_jsonb(${fetchedAt.toISOString()}::text))` }).where(eq(sources.id, prior.id));
    return { sourceId: prior.id, status: "unchanged", previousId: null, pages: read.pages };
  }
  let file: { storageKey: string; sha256: string; size: number } | null = null;
  if (doc.format === "pdf" && doc.bytes) file = await putFile(doc.bytes);
  const title = doc.shortName && !doc.title.includes(doc.shortName) ? `${doc.title} (${doc.shortName})` : doc.title;
  const meta: Record<string, unknown> = {
    docKind: doc.format === "pdf" ? "pdf" : "web_page", host: (() => { try { return new URL(doc.url).hostname.replace(/^www\./, ""); } catch { return null; } })(),
    via: "crawl", fetchedFrom: doc.fetchedFrom, fetchedAt: fetchedAt.toISOString(), pages: read.pages, warnings: read.warnings.length ? read.warnings : undefined,
    crawl: { corpusId, role: doc.role, reason: doc.reason, depth: doc.depth, format: doc.format, reference: doc.reference, amendment: !!doc.amendment, shortName: doc.shortName, ...doc.meta },
    extraction: "skipped: rule texts are read by the rule set's reading passes, not by the library",
  };
  const id = await db.transaction(async (tx) => {
    const [row] = await tx.insert(sources).values({
      householdId: v.graphHouseholdId, graphId: v.graphId, ownerId: v.id, kind: "web", title: webTitle({ url: doc.url, title }).slice(0, 250),
      mime: doc.format === "pdf" ? "application/pdf" : "text/plain", url: doc.url, fetchedAt, textContent: read.text.slice(0, 2_000_000),
      status: "ready", visibility: "household", sensitive: false, meta, contentKey,
      ...(file ? { storageKey: file.storageKey, sha256: file.sha256, size: file.size } : {}),
    }).returning({ id: sources.id });
    // Passages with their place: PDFs per page, text in ~1200-character pieces at paragraph breaks.
    const pieces = read.segments.length
      ? chunkSegments(read.segments).map((c) => ({ text: c.text, locator: c.locator as Record<string, unknown> }))
      : chunkPage(read.text).map((p) => ({ text: p.text, locator: { charStart: p.charStart, charEnd: p.charEnd } as Record<string, unknown> }));
    for (let i = 0; i < pieces.length && i < 3000; i += 200) {
      await tx.insert(chunks).values(pieces.slice(i, Math.min(i + 200, 3000)).map((p, j) => ({
        sourceId: row.id, graphId: v.graphId, ownerId: v.id, idx: i + j, text: p.text, locator: p.locator, search: sql`to_tsvector('simple', ${p.text})`,
      })));
    }
    return row.id;
  });
  if (prior) {
    // A new version of a document the rule set had: the library keeps both, the rule set follows the new one.
    if (prior.ownerId === v.id) await appendRevision({ id, graphId: v.graphId, ownerId: v.id }, { id: prior.id, graphId: prior.graphId, ownerId: prior.ownerId, lineageId: prior.lineageId }).catch((e) => console.warn("[rules] version link failed:", e instanceof Error ? e.message : e));
    else await db.update(sources).set({ supersededAt: new Date() }).where(eq(sources.id, prior.id));
    await db.insert(corpusSources).values({ corpusId, graphId: v.graphId, sourceId: id, role: prior.role }).onConflictDoNothing();
    await db.delete(corpusSources).where(eq(corpusSources.id, prior.linkId));
    return { sourceId: id, status: "changed", previousId: prior.id, pages: read.pages };
  }
  await db.insert(corpusSources).values({ corpusId, graphId: v.graphId, sourceId: id, role: doc.role }).onConflictDoNothing();
  return { sourceId: id, status: "new", previousId: null, pages: read.pages };
}

/** A document stored as the text turned out to be supporting (a one-page view replaced it). */
export async function demote(v: Viewer, corpusId: string, url: string, role: SourceRole): Promise<void> {
  const rows = await db.select({ id: sources.id }).from(sources).where(and(eq(sources.graphId, v.graphId), eq(sources.url, url), isNull(sources.supersededAt)));
  if (!rows.length) return;
  await db.update(corpusSources).set({ role }).where(and(eq(corpusSources.corpusId, corpusId), inArray(corpusSources.sourceId, rows.map((r) => r.id))));
  for (const r of rows) await db.update(sources).set({ meta: sql`jsonb_set(${sources.meta}, '{crawl,role}', to_jsonb(${role}::text))` }).where(eq(sources.id, r.id));
}
