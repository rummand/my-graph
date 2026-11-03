/**
 * Keeps a wiki page's footprint in the graph up to date after a save:
 *   - a `sources` row (kind "wiki") holding the page text, so facts read from it carry provenance;
 *   - a document node for the page (via GBrain), owned by the page owner;
 *   - a "mentions" edge from the page node to every @-mentioned node and every [[linked]] page's node;
 *   - ingestion of the text (debounced), which extracts further facts.
 *
 * Everything here is best effort. The page text is already committed before this runs; a GBrain or ingest failure is
 * logged and never surfaces as a failed save.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { sources, users, wikiPages } from "@/db/schema";
import type { Viewer } from "@/lib/auth";
import { addEdge, readableNodeIds, updateNode, upsertNode, type ProvenanceInput } from "@/lib/gbrain";
import { ingestText } from "@/lib/ingest";
import { extractMentions, extractPageLinks, type DocNode } from "./doc";

type PageRow = typeof wikiPages.$inferSelect;
export type PrevState = { title: string; visibility: PageRow["visibility"]; content: DocNode | null };

const INGEST_DELAY_MS = 10_000;

type G = { __wikiSync?: Map<string, Promise<void>>; __wikiIngest?: Map<string, ReturnType<typeof setTimeout>> };
const g = globalThis as unknown as G;
const chains: Map<string, Promise<void>> = (g.__wikiSync ??= new Map());
const ingestTimers = (g.__wikiIngest ??= new Map());

function warn(step: string, pageId: string, err: unknown) {
  console.warn(`[wiki] ${step} failed for page ${pageId}:`, err instanceof Error ? err.message : err);
}

/** Run graph sync for a page after a save. Syncs for one page run one at a time, in order. Never throws. */
export function syncPageGraphLater(editor: Viewer, pageId: string, prev: PrevState | null): void {
  const before = chains.get(pageId) ?? Promise.resolve();
  const next = before
    .then(() => syncPageGraph(editor, pageId, prev))
    .catch((e: unknown) => warn("graph sync", pageId, e))
    .finally(() => { if (chains.get(pageId) === next) chains.delete(pageId); });
  chains.set(pageId, next);
}

/** The page owner as a Viewer: the graph footprint lives in the owner's brain even when someone else edits. */
async function ownerViewer(editor: Viewer, ownerId: string): Promise<Viewer | null> {
  if (editor.id === ownerId) return editor;
  const [u] = await db.select({ id: users.id, householdId: users.householdId, name: users.name, email: users.email, role: users.role, personNodeId: users.personNodeId })
    .from(users).where(eq(users.id, ownerId)).limit(1);
  return u ?? null;
}

async function syncPageGraph(editor: Viewer, pageId: string, prev: PrevState | null): Promise<void> {
  const [page] = await db.select().from(wikiPages).where(eq(wikiPages.id, pageId)).limit(1);
  if (!page) return; // deleted meanwhile
  const owner = await ownerViewer(editor, page.ownerId);
  if (!owner) return;

  // 1. Source row with the page text.
  let sourceId = page.sourceId;
  try {
    if (!sourceId) {
      const [src] = await db.insert(sources).values({
        householdId: page.householdId, ownerId: page.ownerId, kind: "wiki", title: page.title, mime: "text/plain",
        textContent: page.contentText, status: "pending", visibility: page.visibility,
        meta: { wikiPageId: page.id, slug: page.slug },
      }).returning({ id: sources.id });
      const claimed = await db.update(wikiPages).set({ sourceId: src.id })
        .where(and(eq(wikiPages.id, page.id), isNull(wikiPages.sourceId))).returning({ id: wikiPages.id });
      if (claimed.length) sourceId = src.id;
      else {
        await db.delete(sources).where(eq(sources.id, src.id));
        const [again] = await db.select({ sourceId: wikiPages.sourceId }).from(wikiPages).where(eq(wikiPages.id, page.id));
        sourceId = again?.sourceId ?? null;
      }
    } else {
      await db.update(sources).set({ title: page.title, textContent: page.contentText, visibility: page.visibility })
        .where(eq(sources.id, sourceId));
    }
  } catch (e) {
    warn("source update", page.id, e);
  }

  const prov: ProvenanceInput = {
    sourceId, activity: "manual_edit", agentType: "user", agentId: editor.id, confidence: 1,
  };

  // 2. The page's document node.
  let nodeId = page.nodeId;
  let nodeIsNew = false;
  try {
    if (!nodeId) {
      nodeId = await createPageNode(owner, page, prov);
      nodeIsNew = !!nodeId;
      if (nodeId) {
        await db.update(wikiPages).set({ nodeId }).where(eq(wikiPages.id, page.id));
        if (sourceId) await db.update(sources).set({ nodeId }).where(eq(sources.id, sourceId));
      }
    } else if (prev && (prev.title !== page.title || prev.visibility !== page.visibility)) {
      await updateNode(owner, nodeId, { label: page.title, visibility: page.visibility }, prov);
    }
  } catch (e) {
    warn("page node", page.id, e);
  }

  // 3. Edges for new mentions and page links.
  if (nodeId) {
    const doc = page.content as DocNode;
    const had = new Set<string>();
    if (prev?.content && !nodeIsNew) {
      for (const m of extractMentions(prev.content)) had.add(m.id);
      for (const l of extractPageLinks(prev.content)) had.add(`page:${l.id}`);
    }
    const targets = new Set<string>(extractMentions(doc).filter((m) => !had.has(m.id)).map((m) => m.id));
    const linkIds = extractPageLinks(doc).filter((l) => !had.has(`page:${l.id}`) && l.id !== page.id).map((l) => l.id);
    if (linkIds.length) {
      try {
        const linked = await db.select({ nodeId: wikiPages.nodeId }).from(wikiPages)
          .where(and(inArray(wikiPages.id, linkIds), eq(wikiPages.householdId, page.householdId)));
        for (const l of linked) if (l.nodeId) targets.add(l.nodeId);
      } catch (e) {
        warn("page links", page.id, e);
      }
    }
    targets.delete(nodeId);
    // Mention ids come from the client. The edges are written as the page owner, so only link nodes the person who
    // made this edit can see too: otherwise a child editing a family page could attach the owner's private or
    // sensitive nodes to it by id.
    if (targets.size && editor.id !== owner.id) {
      try {
        const ok = await readableNodeIds(editor, [...targets]);
        for (const t of [...targets]) if (!ok.has(t)) targets.delete(t);
      } catch (e) {
        warn("mention access check", page.id, e);
        targets.clear();
      }
    }
    for (const toId of targets) {
      try {
        await addEdge(owner, { fromId: nodeId, toId, relation: "mentions", confidence: 1, status: "confirmed", visibility: page.visibility }, prov);
      } catch (e) {
        warn(`mention edge → ${toId}`, page.id, e);
      }
    }
  }

  // 4. Ingest (debounced: autosave fires every few seconds while someone types).
  if (sourceId) scheduleIngest(owner, sourceId);
}

async function createPageNode(owner: Viewer, page: PageRow, prov: ProvenanceInput): Promise<string | null> {
  // GBrain reuses an existing document node with the same name. Only accept it if it's this page's own node;
  // otherwise use a more specific label so two pages (or a page and a file) with the same title stay separate.
  const labels = [page.title, `${page.title} (wiki page)`, `${page.title} (wiki: ${page.slug})`];
  for (const label of labels) {
    const { node, created } = await upsertNode(owner, {
      type: "document", label, visibility: page.visibility, props: { wikiPageId: page.id, slug: page.slug },
    }, prov);
    if (created || node.props?.wikiPageId === page.id) return node.id;
  }
  return null;
}

function scheduleIngest(owner: Viewer, sourceId: string) {
  const t = ingestTimers.get(sourceId);
  if (t) clearTimeout(t);
  ingestTimers.set(sourceId, setTimeout(() => {
    ingestTimers.delete(sourceId);
    void Promise.resolve()
      .then(() => ingestText(owner, sourceId))
      .catch((e) => warn("ingest", sourceId, e));
  }, INGEST_DELAY_MS));
}

/** Forget pending work for a deleted page. */
export function cancelPendingIngest(sourceId: string | null) {
  if (!sourceId) return;
  const t = ingestTimers.get(sourceId);
  if (t) clearTimeout(t);
  ingestTimers.delete(sourceId);
}
