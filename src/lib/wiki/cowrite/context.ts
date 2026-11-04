/**
 * What the assistant may draw on when co-writing a page (server-only). Everything comes through GBrain search with
 * the asking person's Viewer, so it only ever sees what they may see in their current graph. Source rows are
 * re-read with the same graph scope to label them and to know who can see each one (for the sensitivity warning).
 */
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { sources, wikiPages } from "@/db/schema";
import type { Viewer } from "@/lib/auth";
import * as gbrain from "@/lib/gbrain";
import { pageReadSql } from "../access";
import type { CowriteSource } from "./prompt";

const MAX_SOURCES = 8;
const MAX_NODES = 6;
const CHUNKS_PER_SOURCE = 2;

const NODE_WHAT: Record<string, string> = { person: "person", place: "place", event: "event", topic: "topic", document: "document", source: "document" };

function sourceWhat(kind: string, mime: string | null, meta: Record<string, unknown>): string {
  if (kind === "wiki") return "wiki page";
  if (kind === "chat") return "note from a chat";
  if (kind === "manual") return "note";
  if (kind === "sync") return typeof meta.provider === "string" && /aula/i.test(meta.provider) ? "Aula message" : "synced message";
  if (mime?.startsWith("image/")) return "photo";
  if (mime?.startsWith("audio/")) return "recording";
  return "document";
}

function nodeText(n: gbrain.GNode): string {
  const props = Object.entries(n.props ?? {})
    .filter(([, v]) => v !== null && v !== "" && ["string", "number", "boolean"].includes(typeof v))
    .slice(0, 10)
    .map(([k, v]) => `${k.replace(/_/g, " ")}: ${v}`);
  return [n.summary ?? "", props.join("; ")].filter(Boolean).join("\n") || n.label;
}

async function searchSafe(v: Viewer, q: string, limit: number): Promise<gbrain.SearchHit[]> {
  if (!q.trim()) return [];
  try {
    return await gbrain.search(v, q, { limit });
  } catch (e) {
    console.warn("[wiki cowrite] search failed", e);
    return [];
  }
}

/**
 * Numbered sources for one request: chunks of library documents and other pages (grouped per source), and graph
 * facts. The page being written is left out (it is already in the prompt).
 */
export async function gatherCowriteSources(
  v: Viewer, page: { id: string; title: string; nodeId: string | null; sourceId: string | null }, instruction: string,
): Promise<CowriteSource[]> {
  let hits = await searchSafe(v, instruction, 16);
  if (hits.length < 6) {
    const more = await searchSafe(v, `${page.title} ${instruction}`.slice(0, 400), 10);
    const seen = new Set(hits.map((h) => h.node?.id ?? h.chunk?.id));
    hits = [...hits, ...more.filter((h) => !seen.has(h.node?.id ?? h.chunk?.id))];
  }

  // Group chunk hits by their source, best first.
  const bySource = new Map<string, string[]>();
  for (const h of hits) {
    if (h.kind !== "chunk" || !h.chunk || h.chunk.sourceId === page.sourceId) continue;
    const list = bySource.get(h.chunk.sourceId) ?? [];
    if (list.length < CHUNKS_PER_SOURCE) list.push(h.chunk.text);
    bySource.set(h.chunk.sourceId, list);
  }
  const sourceIds = [...bySource.keys()].slice(0, MAX_SOURCES);
  const rows = sourceIds.length
    ? await db.select({
      id: sources.id, title: sources.title, kind: sources.kind, mime: sources.mime, meta: sources.meta,
      visibility: sources.visibility, sensitive: sources.sensitive, createdAt: sources.createdAt,
    }).from(sources).where(and(inArray(sources.id, sourceIds), eq(sources.graphId, v.graphId)))
    : [];
  // Wiki sources cite the page itself (only pages this person can read).
  const wikiIds = rows.filter((r) => r.kind === "wiki").map((r) => r.id);
  const pages = wikiIds.length
    ? await db.select({ id: wikiPages.id, sourceId: wikiPages.sourceId, slug: wikiPages.slug, title: wikiPages.title, visibility: wikiPages.visibility })
      .from(wikiPages).where(and(inArray(wikiPages.sourceId, wikiIds), pageReadSql(v)))
    : [];
  const pageBySource = new Map(pages.map((p) => [p.sourceId, p]));
  const rowById = new Map(rows.map((r) => [r.id, r]));

  const out: CowriteSource[] = [];
  for (const id of sourceIds) {
    const r = rowById.get(id);
    if (!r) continue; // not in this graph: never shown
    const wiki = r.kind === "wiki" ? pageBySource.get(r.id) : null;
    if (r.kind === "wiki" && !wiki) continue;
    out.push({
      n: 0, kind: wiki ? "page" : "source", id: wiki?.id ?? r.id, slug: wiki?.slug ?? null, title: wiki?.title ?? r.title,
      what: sourceWhat(r.kind, r.mime, r.meta ?? {}), when: r.createdAt.toISOString().slice(0, 10),
      visibility: wiki?.visibility ?? r.visibility, sensitive: r.sensitive, text: bySource.get(id)!.join("\n…\n"),
    });
  }

  const nodes = hits.filter((h) => h.kind === "node" && h.node && h.node.id !== page.nodeId && !(h.node.type === "document" && h.node.props?.wikiPageId === page.id))
    .slice(0, MAX_NODES).map((h) => h.node!);
  for (const n of nodes) {
    out.push({
      n: 0, kind: "node", id: n.id, title: n.label, what: NODE_WHAT[n.type] ?? "fact",
      when: n.startAt ? n.startAt.toISOString().slice(0, n.timePrecision === "minute" ? 16 : 10).replace("T", " ") : null,
      visibility: n.visibility, sensitive: n.sensitive, text: nodeText(n),
    });
  }
  return out.map((s, i) => ({ ...s, n: i + 1 }));
}
