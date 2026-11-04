/**
 * CONTRACT: what the assistant remembers in a graph (preferences, family rules, notes), with provenance.
 * Owned by the memory workstream; signatures are fixed.
 * Every function is scoped to the viewer's current graph and respects visibility:
 *  - only memories in viewer.graphId, and only while the viewer may use Memory (not children, not guests);
 *  - private = only whoever added it; parents = parents (editors outside the family graph); household = everyone in the graph.
 * Library functions never throw for "not allowed": they return empty/null/false, so chat keeps working. The routes
 * check access first and answer 403 with a reason.
 */
import { and, desc, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import type { Viewer } from "@/lib/auth";
import { db } from "@/db";
import { assistantActivity, automationRuns, automations, conversations, memories, nodes, sources, users } from "@/db/schema";
import { accessContext } from "@/lib/gbrain";
import { nodeReadSql, sourceReadSql } from "@/lib/gbrain/access";
import { embed } from "@/lib/mux";
import { scopeOf } from "@/lib/graphs/pure";
import { recordMentions } from "@/lib/mentions";
import { mentionMarkup } from "@/lib/mentions/markup";
import {
  canAddMemory, canEditMemory, cleanText, cosine, DEFAULT_CONTEXT_LIMIT, findDuplicate, formatMemoryBlock, initialStatus,
  memoryAllowed, MEMORY_MAX_CHARS, rankForContext,
  type MemoryKind as K, type MemoryOrigin as O, type MemoryStatus as S, type MemoryVisibility,
} from "./pure";
import type { MemoryAbout, MemoryFrom, MemoryView } from "./types";

export type MemoryKind = K;
export type MemoryOrigin = O;
export type MemoryStatus = S;

export type Memory = {
  id: string; kind: MemoryKind; text: string; aboutNodeIds: string[]; origin: MemoryOrigin; status: MemoryStatus;
  conversationId: string | null; messageId: string | null; sourceId: string | null; runId: string | null; quote: string | null;
  confidence: number; visibility: "private" | "parents" | "household"; ownerId: string; ownerName: string;
  createdByKind: "user" | "assistant"; createdAt: Date; updatedAt: Date; lastUsedAt: Date | null;
};

export type MemoryInput = {
  kind: MemoryKind; text: string; aboutNodeIds?: string[]; origin: MemoryOrigin; createdByKind: "user" | "assistant";
  conversationId?: string; messageId?: string; sourceId?: string; runId?: string; quote?: string; confidence?: number;
  visibility?: "private" | "parents" | "household";
  /** Who to name in the activity log; the Brain Keeper passes "keeper". */
  actor?: "keeper";
};

export { memoryAllowed, canAddMemory, canEditMemory } from "./pure";
export type { MemoryView, MemoryAbout, MemoryFrom, PersonOption } from "./types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (s: unknown): s is string => typeof s === "string" && UUID.test(s);

/* ── Reading ─────────────────────────────────────────────────────────────────────────────────────────── */

/** WHERE: memories this viewer may read in their current graph. */
function readSql(v: Viewer): SQL {
  const s = scopeOf(v);
  if (!memoryAllowed(v) || !s.graphId) return sql`false`;
  const parent = s.role === "owner" || s.role === "parent";
  const vis = parent ? inArray(memories.visibility, ["household", "parents"]) : eq(memories.visibility, "household");
  return and(eq(memories.graphId, s.graphId), or(eq(memories.ownerId, v.id), vis))!;
}

const cols = {
  id: memories.id, graphId: memories.graphId, ownerId: memories.ownerId, kind: memories.kind, text: memories.text,
  aboutNodeIds: memories.aboutNodeIds, origin: memories.origin, conversationId: memories.conversationId,
  messageId: memories.messageId, sourceId: memories.sourceId, runId: memories.runId, quote: memories.quote,
  confidence: memories.confidence, status: memories.status, visibility: memories.visibility,
  createdByKind: memories.createdByKind, createdAt: memories.createdAt, updatedAt: memories.updatedAt,
  lastUsedAt: memories.lastUsedAt, ownerName: users.name,
};
type Row = { [k in keyof typeof cols]: (typeof cols)[k]["_"]["data"] } & { ownerName: string | null };

function toMemory(r: Row): Memory {
  return {
    id: r.id, kind: r.kind, text: r.text, aboutNodeIds: r.aboutNodeIds ?? [], origin: r.origin, status: r.status,
    conversationId: r.conversationId, messageId: r.messageId, sourceId: r.sourceId, runId: r.runId, quote: r.quote,
    confidence: r.confidence, visibility: r.visibility, ownerId: r.ownerId, ownerName: r.ownerName ?? "Someone",
    createdByKind: r.createdByKind, createdAt: r.createdAt, updatedAt: r.updatedAt, lastUsedAt: r.lastUsedAt,
  };
}

async function selectMemories(v: Viewer, where: (SQL | undefined)[], limit = 500): Promise<Memory[]> {
  const rows = await db.select(cols).from(memories).leftJoin(users, eq(users.id, memories.ownerId))
    .where(and(readSql(v), ...where)).orderBy(desc(memories.updatedAt)).limit(limit);
  return (rows as Row[]).map(toMemory);
}

export async function listMemories(v: Viewer, opts: { status?: MemoryStatus | "all"; kind?: MemoryKind; aboutNodeId?: string; q?: string } = {}): Promise<Memory[]> {
  if (!memoryAllowed(v)) return [];
  const where: (SQL | undefined)[] = [];
  if (opts.status && opts.status !== "all") where.push(eq(memories.status, opts.status));
  if (opts.kind) where.push(opts.kind === "note" ? inArray(memories.kind, ["note", "fact"]) : eq(memories.kind, opts.kind));
  if (opts.aboutNodeId) {
    if (!isUuid(opts.aboutNodeId)) return [];
    where.push(sql`${memories.aboutNodeIds} @> ${JSON.stringify([opts.aboutNodeId])}::jsonb`);
  }
  const q = opts.q?.trim().slice(0, 200);
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push(sql`(${memories.text} ilike ${like} or coalesce(${memories.quote}, '') ilike ${like})`);
  }
  return selectMemories(v, where);
}

/** One memory the viewer may read, or null. */
export async function getMemory(v: Viewer, id: string): Promise<Memory | null> {
  if (!isUuid(id) || !memoryAllowed(v)) return null;
  const [m] = await selectMemories(v, [eq(memories.id, id)], 1);
  return m ?? null;
}

const rowFor = (v: Viewer, m: Pick<Memory, "ownerId" | "visibility">) => ({ ownerId: m.ownerId, visibility: m.visibility, graphId: v.graphId });

/* ── Writing ─────────────────────────────────────────────────────────────────────────────────────────── */

/** Person/place/topic nodes the viewer may read in this graph, by id (keeps memories from pointing across graphs). */
async function readableNodes(v: Viewer, ids: string[]): Promise<MemoryAbout[]> {
  const valid = [...new Set(ids)].filter(isUuid).slice(0, 50);
  if (!valid.length) return [];
  const ctx = await accessContext(v);
  const rows = await db.select({ id: nodes.id, label: nodes.label, type: nodes.type }).from(nodes)
    .where(and(inArray(nodes.id, valid), sql`${nodes.mergedInto} is null`, nodeReadSql(ctx, "nodes")));
  return rows;
}

/** Where a memory came from, checked: links to another graph's chat, file or run are dropped. */
async function checkedOrigin(v: Viewer, input: MemoryInput) {
  let conversationId: string | null = null, messageId: string | null = null, sourceId: string | null = null, runId: string | null = null;
  let narrowest: MemoryVisibility | null = null;
  if (isUuid(input.conversationId)) {
    const [c] = await db.select({ id: conversations.id, sensitivity: conversations.sensitivity }).from(conversations)
      .where(and(eq(conversations.id, input.conversationId), eq(conversations.graphId, v.graphId), eq(conversations.userId, v.id)));
    if (c) {
      conversationId = c.id;
      messageId = isUuid(input.messageId) ? input.messageId : null;
      // A chat that touched private or parents-only things keeps what it learned just as narrow.
      if (c.sensitivity === "private") narrowest = "private";
      else if (c.sensitivity === "parents") narrowest = "parents";
    }
  }
  if (isUuid(input.sourceId)) {
    const ctx = await accessContext(v);
    const [s] = await db.select({ id: sources.id }).from(sources).where(and(eq(sources.id, input.sourceId), sourceReadSql(ctx, "sources")));
    if (s) sourceId = s.id;
  }
  if (isUuid(input.runId)) {
    const [r] = await db.select({ id: automationRuns.id }).from(automationRuns)
      .where(and(eq(automationRuns.id, input.runId), eq(automationRuns.graphId, v.graphId)));
    if (r) runId = r.id;
  }
  return { conversationId, messageId, sourceId, runId, narrowest };
}

const VIS_RANK: Record<MemoryVisibility, number> = { private: 0, parents: 1, household: 2 };
const narrower = (a: MemoryVisibility, b: MemoryVisibility | null) => (b && VIS_RANK[b] < VIS_RANK[a] ? b : a);

/** Saves a memory. Memories from outside content (origin "external"/"upload") are stored as pending until confirmed. */
export async function addMemory(v: Viewer, input: MemoryInput): Promise<Memory | null> {
  if (!canAddMemory(v)) return null;
  const text = cleanText(input.text ?? "", MEMORY_MAX_CHARS);
  if (text.length < 2) return null;
  const kind: MemoryKind = (["preference", "rule", "fact", "note"] as const).includes(input.kind) ? input.kind : "note";
  const about = (await readableNodes(v, input.aboutNodeIds ?? [])).map((n) => n.id);
  const origin = await checkedOrigin(v, input);
  const status = initialStatus(input.origin);
  const visibility = narrower(input.visibility ?? "household", origin.narrowest);
  const quote = input.quote ? cleanText(input.quote, 400) : null;
  const confidence = Math.max(0, Math.min(1, Number.isFinite(input.confidence) ? input.confidence! : input.createdByKind === "user" ? 1 : 0.8));

  const id = await db.transaction(async (tx) => {
    // One writer per graph at a time, so two near-identical saves can't both slip past the duplicate check.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`memory:${v.graphId}`}))`);
    const existing = await tx.select(cols).from(memories).leftJoin(users, eq(users.id, memories.ownerId))
      .where(readSql(v)).orderBy(desc(memories.updatedAt)).limit(1000);
    const dup = findDuplicate((existing as Row[]).map(toMemory), text, kind);
    if (dup) {
      if (canEditMemory(v, rowFor(v, dup))) {
        const merged = [...new Set([...dup.aboutNodeIds, ...about])];
        // Saying it again yourself counts as confirming a pending one; outside content never confirms anything.
        const confirm = dup.status === "pending" && status === "active" && input.createdByKind === "user";
        await tx.update(memories).set({ aboutNodeIds: merged, updatedAt: new Date(), ...(confirm ? { status: "active" as const } : {}) })
          .where(eq(memories.id, dup.id));
      }
      return dup.id;
    }
    const [row] = await tx.insert(memories).values({
      graphId: v.graphId, ownerId: v.id, kind, text, aboutNodeIds: about, origin: input.origin,
      conversationId: origin.conversationId, messageId: origin.messageId, sourceId: origin.sourceId, runId: origin.runId,
      quote, confidence, status, visibility, createdByKind: input.createdByKind,
    }).returning({ id: memories.id });
    if (input.createdByKind === "assistant") {
      await tx.insert(assistantActivity).values({
        graphId: v.graphId, userId: v.id,
        actor: input.actor ?? (input.origin === "automation" ? "automation" : input.origin === "chat" ? "chat" : "ingest"),
        action: "saved_memory",
        summary: status === "pending" ? `Found something to remember and is waiting for you to confirm it: "${cleanText(text, 120)}"` : `Remembered: "${cleanText(text, 120)}"`,
        subjectType: "memory", subjectId: row.id, runId: origin.runId, conversationId: origin.conversationId, visibility,
      });
    }
    return row.id;
  });
  await noteMentions(v, id);
  return getMemory(v, id);
}

/**
 * Record which nodes a memory is about in `mentions` (so "Mentioned in" on a node lists it): the @mentions in its
 * text plus its aboutNodeIds. Best effort; a failure never fails the save.
 */
async function noteMentions(v: Viewer, id: string) {
  try {
    const [m] = await db.select({ text: memories.text, about: memories.aboutNodeIds }).from(memories)
      .where(and(eq(memories.id, id), eq(memories.graphId, v.graphId)));
    if (!m) return;
    const ids = m.about ?? [];
    const labels = ids.length ? await db.select({ id: nodes.id, label: nodes.label }).from(nodes).where(and(inArray(nodes.id, ids), eq(nodes.graphId, v.graphId))) : [];
    const about = labels.map((n) => mentionMarkup(n.label, n.id)).join(" ");
    await recordMentions(v, { inType: "memory", inId: id, text: `${m.text} ${about}` });
  } catch (e) {
    console.error("[memory] recording mentions failed", e);
  }
}

export async function updateMemory(v: Viewer, id: string, patch: Partial<Pick<Memory, "text" | "kind" | "status" | "aboutNodeIds" | "visibility">>): Promise<Memory | null> {
  const m = await getMemory(v, id);
  if (!m || !canEditMemory(v, rowFor(v, m))) return null;
  const set: Partial<typeof memories.$inferInsert> = { updatedAt: new Date() };
  if (patch.text !== undefined) {
    const text = cleanText(patch.text, MEMORY_MAX_CHARS);
    if (text.length < 2) return null;
    set.text = text;
  }
  if (patch.kind && (["preference", "rule", "fact", "note"] as const).includes(patch.kind)) set.kind = patch.kind;
  if (patch.status && (["active", "pending", "paused"] as const).includes(patch.status)) {
    // Nothing goes back to "waiting for confirmation" once a person has decided.
    if (patch.status === "pending" && m.status !== "pending") return null;
    set.status = patch.status;
  }
  if (patch.aboutNodeIds) set.aboutNodeIds = (await readableNodes(v, patch.aboutNodeIds)).map((n) => n.id);
  if (patch.visibility && (["private", "parents", "household"] as const).includes(patch.visibility)) {
    // Only the person who added a memory decides who else sees it.
    if (patch.visibility !== m.visibility && m.ownerId !== v.id) return null;
    set.visibility = patch.visibility;
  }
  await db.update(memories).set(set).where(and(eq(memories.id, m.id), eq(memories.graphId, v.graphId)));
  if (set.text !== undefined || set.aboutNodeIds) await noteMentions(v, m.id);
  return getMemory(v, m.id);
}

export async function deleteMemory(v: Viewer, id: string): Promise<boolean> {
  const m = await getMemory(v, id);
  if (!m || !canEditMemory(v, rowFor(v, m))) return false;
  const out = await db.delete(memories).where(and(eq(memories.id, m.id), eq(memories.graphId, v.graphId))).returning({ id: memories.id });
  return out.length > 0;
}

/* ── For the assistant ───────────────────────────────────────────────────────────────────────────────── */

const g = globalThis as unknown as { __mgMemoryVec?: Map<string, { text: string; vec: number[] }> };
const vecCache = g.__mgMemoryVec ?? (g.__mgMemoryVec = new Map());

/** Embedding similarity of question to each memory, by id. null when mux is down or slow (keyword ranking only). */
async function semanticScores(v: Viewer, question: string, items: Memory[]): Promise<Map<string, number> | undefined> {
  if (!question.trim() || !items.length) return undefined;
  const missing = items.filter((m) => vecCache.get(m.id)?.text !== m.text).slice(0, 64);
  const texts = [question.slice(0, 2000), ...missing.map((m) => m.text)];
  const out = await Promise.race([
    embed(texts, { userId: v.id, agent: "memory", sensitive: true, graphId: v.graphId }).catch(() => null),
    new Promise<null>((r) => setTimeout(() => r(null), 1500)),
  ]);
  if (!out || out.length !== texts.length || out[0]?.length !== 1024) return undefined;
  missing.forEach((m, i) => vecCache.set(m.id, { text: m.text, vec: out[i + 1] }));
  if (vecCache.size > 5000) vecCache.delete(vecCache.keys().next().value!);
  const scores = new Map<string, number>();
  for (const m of items) {
    const c = vecCache.get(m.id);
    if (c && c.text === m.text) scores.set(m.id, cosine(out[0], c.vec));
  }
  return scores;
}

/**
 * The active memories and rules the assistant should apply right now, as a prompt-ready block plus the items
 * (so callers can mark them used and cite them). Only active memories the viewer may read; never pending ones.
 */
export async function memoryContext(v: Viewer, opts: { question?: string; limit?: number } = {}): Promise<{ text: string; items: Memory[] }> {
  try {
    if (!memoryAllowed(v)) return { text: "", items: [] };
    const active = await selectMemories(v, [eq(memories.status, "active")], 300);
    if (!active.length) return { text: "", items: [] };
    const labels = new Map((await readableNodes(v, active.flatMap((m) => m.aboutNodeIds))).map((n) => [n.id, n.label]));
    const withLabels = active.map((m) => ({ ...m, aboutLabels: m.aboutNodeIds.map((id) => labels.get(id)).filter((l): l is string => !!l) }));
    const limit = Math.max(1, Math.min(opts.limit ?? DEFAULT_CONTEXT_LIMIT, 40));
    const q = opts.question?.trim() ?? "";
    // Only ask mux when there are more memories than fit, and only about the ones that need ranking.
    const semantic = q && withLabels.length > limit ? await semanticScores(v, q, withLabels.filter((m) => m.kind !== "rule")) : undefined;
    const chosen = rankForContext(withLabels, q, limit, semantic);
    const items = chosen.map(({ aboutLabels: _labels, ...m }) => m);
    return { text: formatMemoryBlock(chosen), items };
  } catch (e) {
    console.error("[memory] context", e);
    return { text: "", items: [] };
  }
}

export async function markMemoriesUsed(v: Viewer, ids: string[]): Promise<void> {
  const valid = [...new Set(ids)].filter(isUuid).slice(0, 100);
  if (!valid.length || !memoryAllowed(v)) return;
  try {
    await db.update(memories).set({ lastUsedAt: new Date() })
      .where(and(inArray(memories.id, valid), eq(memories.status, "active"), readSql(v)));
  } catch (e) {
    console.error("[memory] mark used", e);
  }
}

/* ── For the Memory page and panel ───────────────────────────────────────────────────────────────────── */

/** Adds who it's about (only people the viewer can see), where it came from (with links they may open), and canEdit. */
export async function viewMemories(v: Viewer, list: Memory[]): Promise<MemoryView[]> {
  if (!list.length) return [];
  const about = new Map((await readableNodes(v, list.flatMap((m) => m.aboutNodeIds))).map((n) => [n.id, n]));
  const convIds = [...new Set(list.map((m) => m.conversationId).filter(isUuid))];
  const srcIds = [...new Set(list.map((m) => m.sourceId).filter(isUuid))];
  const runIds = [...new Set(list.map((m) => m.runId).filter(isUuid))];
  const ctx = srcIds.length ? await accessContext(v) : null;
  const [convs, srcs, runs] = await Promise.all([
    convIds.length ? db.select({ id: conversations.id, title: conversations.title, userId: conversations.userId }).from(conversations)
      .where(and(inArray(conversations.id, convIds), eq(conversations.graphId, v.graphId))) : [],
    srcIds.length && ctx ? db.select({ id: sources.id, title: sources.title }).from(sources)
      .where(and(inArray(sources.id, srcIds), sourceReadSql(ctx, "sources"))) : [],
    runIds.length ? db.select({ id: automationRuns.id, name: automations.name, automationId: automations.id }).from(automationRuns)
      .innerJoin(automations, eq(automations.id, automationRuns.automationId))
      .where(and(inArray(automationRuns.id, runIds), eq(automationRuns.graphId, v.graphId))) : [],
  ]);
  const conv = new Map(convs.map((c) => [c.id, c]));
  const src = new Map(srcs.map((s) => [s.id, s]));
  const run = new Map(runs.map((r) => [r.id, r]));

  return list.map((m) => {
    let from: MemoryFrom;
    const c = m.conversationId ? conv.get(m.conversationId) : undefined;
    const s = m.sourceId ? src.get(m.sourceId) : undefined;
    const r = m.runId ? run.get(m.runId) : undefined;
    if (m.origin === "upload" || m.origin === "external") {
      from = s ? { label: `From ${s.title}`, href: `/library/${s.id}` }
        : { label: m.origin === "upload" ? "From an uploaded document" : "From an outside document", href: null };
    } else if (m.origin === "automation") {
      from = r ? { label: `From the automation "${r.name}"`, href: m.ownerId === v.id ? `/automations?run=${m.runId}` : null } : { label: "From an automation run", href: null };
    } else if (m.origin === "chat") {
      from = c && c.userId === v.id ? { label: `From your chat "${c.title}"`, href: `/chat/${c.id}` }
        : { label: m.ownerId === v.id ? "From one of your chats" : `From a chat of ${m.ownerName}'s`, href: null };
    } else {
      from = { label: m.ownerId === v.id ? "You added this" : `${m.ownerName} added this`, href: null };
    }
    return {
      id: m.id, kind: m.kind, text: m.text, status: m.status, origin: m.origin, visibility: m.visibility,
      aboutNodeIds: m.aboutNodeIds.filter((id) => about.has(id)), about: m.aboutNodeIds.map((id) => about.get(id)).filter((n): n is MemoryAbout => !!n),
      from, quote: m.quote, confidence: m.confidence, ownerId: m.ownerId, ownerName: m.ownerName, createdByKind: m.createdByKind,
      createdAt: m.createdAt.toISOString(), updatedAt: m.updatedAt.toISOString(), lastUsedAt: m.lastUsedAt?.toISOString() ?? null,
      canEdit: canEditMemory(v, rowFor(v, m)),
    };
  });
}

/** People in the current graph the viewer can see, for "who it applies to". */
export async function memoryPeople(v: Viewer): Promise<{ id: string; label: string }[]> {
  if (!memoryAllowed(v)) return [];
  const ctx = await accessContext(v);
  return db.select({ id: nodes.id, label: nodes.label }).from(nodes)
    .where(and(eq(nodes.type, "person"), sql`${nodes.mergedInto} is null`, nodeReadSql(ctx, "nodes")))
    .orderBy(nodes.label).limit(200);
}
