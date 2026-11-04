/**
 * CONTRACT: @mentions everywhere (owned by the meta-model workstream). Server-only except ./markup.
 *
 *   parseMentions(text)                          → [{ label, nodeId, start, end }]
 *   recordMentions(v, { inType, inId, text })    → rows in `mentions` for the nodes the viewer can see in this graph
 *   searchMentionables(v, q)                     → nodes of every type and kind in the current graph, for the typeahead
 *   mentionCard(v, nodeId)                       → kind, key facts and latest change, for the hover card
 *
 * Every read goes through GBrain with the viewer, so a mention never reveals a node from another graph or one the
 * viewer can't see.
 */
import { and, eq, notInArray } from "drizzle-orm";
import { db } from "@/db";
import { mentions } from "@/db/schema";
import type { Viewer } from "@/lib/auth";
import { historyOf } from "@/lib/changes";
import { getNode, isUuid, listNodes, neighbourhood, readableNodeIds, type GNode, type NodeType } from "@/lib/gbrain";
import { getMeta } from "@/lib/meta";
import { NODE_TYPE_LABELS, type MetaNodeType } from "@/lib/meta/types";
import { parseMentions } from "./markup";

export { parseMentions, mentionedIds, toMarkup, fromMarkup, mentionMarkup, MENTION_RE } from "./markup";
export type { ParsedMention } from "./markup";

export type MentionInType = "message" | "wiki" | "reminder" | "memory" | "automation" | "recipe" | "note" | "change_set";

/**
 * Record where nodes are mentioned. Replaces the rows for (inType, inId) with the mentions in `text` that point at
 * nodes the viewer can read in their current graph; others are ignored. Returns the node ids recorded.
 */
export async function recordMentions(v: Viewer, input: { inType: MentionInType | string; inId: string; text: string }): Promise<string[]> {
  if (!v.graphId || !isUuid(input.inId)) return [];
  const parsed = parseMentions(input.text).filter((m) => isUuid(m.nodeId));
  const ids = [...new Set(parsed.map((m) => m.nodeId))].slice(0, 100);
  const ok = ids.length ? await readableNodeIds(v, ids) : new Set<string>();
  const keep = ids.filter((id) => ok.has(id));
  await db.transaction(async (tx) => {
    const where = [eq(mentions.graphId, v.graphId), eq(mentions.inType, input.inType), eq(mentions.inId, input.inId)];
    await tx.delete(mentions).where(keep.length ? and(...where, notInArray(mentions.nodeId, keep)) : and(...where));
    if (!keep.length) return;
    await tx.insert(mentions).values(keep.map((nodeId) => ({
      graphId: v.graphId, nodeId, inType: input.inType, inId: input.inId,
      label: parsed.find((m) => m.nodeId === nodeId)?.label ?? null, createdBy: v.id,
    }))).onConflictDoNothing();
  });
  return keep;
}

export type Mentionable = {
  nodeId: string; label: string; type: string; typeLabel: string; kindKey: string | null; kindLabel: string | null;
  /** The node's kind is still a candidate (emergent, not yet accepted). */
  emergentKind: boolean; summary: string | null; isYou: boolean;
};

function toMentionable(n: GNode, meta: Awaited<ReturnType<typeof getMeta>>, selfId: string | null): Mentionable {
  const k = n.kind ? (meta.kind(n.type, n.kind) ?? meta.candidates?.kinds.find((c) => c.nodeType === n.type && c.key === n.kind)) : undefined;
  return {
    nodeId: n.id, label: n.label, type: n.type, typeLabel: NODE_TYPE_LABELS[n.type as MetaNodeType]?.one ?? n.type,
    kindKey: n.kind ?? null, kindLabel: k?.label ?? null, emergentKind: k?.status === "candidate", summary: n.summary, isYou: n.id === selfId,
  };
}

/**
 * Typeahead over everything in the current graph the viewer can read: by name, and by kind ("@depart" lists the
 * departments). Empty query = recently changed things.
 */
export async function searchMentionables(v: Viewer, q: string, opts: { limit?: number; types?: NodeType[] } = {}): Promise<Mentionable[]> {
  const limit = Math.min(opts.limit ?? 8, 20);
  const query = q.trim().slice(0, 60);
  const meta = await getMeta(v);
  const byName = await listNodes(v, { q: query || undefined, limit: limit * 2 });
  const results = new Map<string, GNode>(byName.map((n) => [n.id, n]));
  if (query.length >= 2) {
    const lc = query.toLowerCase();
    const kinds = [...meta.kinds.filter((k) => !k.hidden), ...(meta.candidates?.kinds ?? [])]
      .filter((k) => k.label.toLowerCase().startsWith(lc) || (k.pluralLabel ?? "").toLowerCase().startsWith(lc)).slice(0, 3);
    for (const k of kinds) {
      const ofKind = await listNodes(v, { type: k.nodeType as NodeType, limit: 30 });
      for (const n of ofKind.filter((n) => n.kind === k.key).slice(0, limit)) results.set(n.id, n);
    }
  }
  let list = [...results.values()];
  if (opts.types?.length) list = list.filter((n) => opts.types!.includes(n.type));
  list = list.filter((n) => n.type !== "source" && n.type !== "document" || query.length > 0);
  const lc = query.toLowerCase();
  list.sort((a, b) => rank(a, lc) - rank(b, lc) || a.label.localeCompare(b.label));
  return list.slice(0, limit).map((n) => toMentionable(n, meta, v.personNodeId));
}

function rank(n: GNode, q: string): number {
  if (!q) return 0;
  const l = n.label.toLowerCase();
  if (l === q) return 0;
  if (l.startsWith(q)) return 1;
  if (l.split(/\s+/).some((w) => w.startsWith(q))) return 2;
  return 3;
}

export type MentionCard = Mentionable & {
  facts: { relation: string; otherId: string; otherLabel: string; otherType: string }[];
  latest: { what: string; who: string | null; at: string } | null;
  href: string;
};

/** What the hover card shows for a mention: kind, a few key facts and the latest change. Null when not readable. */
export async function mentionCard(v: Viewer, nodeId: string): Promise<MentionCard | null> {
  if (!isUuid(nodeId)) return null;
  const node = await getNode(v, nodeId);
  if (!node) return null;
  const meta = await getMeta(v);
  const hood = await neighbourhood(v, nodeId, 1).catch(() => ({ nodes: [], edges: [] }));
  const byId = new Map(hood.nodes.map((n) => [n.id, n]));
  const facts = hood.edges
    .filter((e) => e.status !== "rejected" && e.status !== "superseded")
    .sort((a, b) => b.confidence - a.confidence || +b.createdAt - +a.createdAt)
    .slice(0, 4)
    .flatMap((e) => {
      const out = e.fromId === nodeId;
      const other = byId.get(out ? e.toId : e.fromId);
      if (!other) return [];
      return [{ relation: meta.relationLabel(e.relation, out ? "out" : "in"), otherId: other.id, otherLabel: other.id === v.personNodeId ? "you" : other.label, otherType: other.type }];
    });
  const [last] = await historyOf(v, { subjectId: nodeId, limit: 1 }).catch(() => []);
  const latest = last
    ? { what: last.kind === "created" ? "Added" : last.field ? `Changed ${last.field.replace(/_/g, " ")}` : titleOf(last.kind), who: last.actorName, at: new Date(last.at).toISOString() }
    : { what: +node.updatedAt - +node.createdAt > 60_000 ? "Changed" : "Added", who: null, at: node.updatedAt.toISOString() };
  return { ...toMentionable(node, meta, v.personNodeId), facts, latest, href: `/node/${node.id}` };
}

const titleOf = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Where a node is mentioned in this graph (newest first). */
export async function mentionsOf(v: Viewer, nodeId: string, limit = 20) {
  if (!v.graphId || !isUuid(nodeId)) return [];
  const ok = await readableNodeIds(v, [nodeId]);
  if (!ok.has(nodeId)) return [];
  return db.select({ inType: mentions.inType, inId: mentions.inId, label: mentions.label, at: mentions.createdAt })
    .from(mentions).where(and(eq(mentions.graphId, v.graphId), eq(mentions.nodeId, nodeId))).limit(limit);
}

/** Readable nodes among ids (for resolving mention markup into context). */
export async function resolveMentions(v: Viewer, text: string): Promise<{ nodeId: string; label: string }[]> {
  const parsed = parseMentions(text);
  if (!parsed.length) return [];
  const ok = await readableNodeIds(v, [...new Set(parsed.map((p) => p.nodeId))].filter(isUuid));
  return parsed.filter((p) => ok.has(p.nodeId)).map((p) => ({ nodeId: p.nodeId, label: p.label }));
}

