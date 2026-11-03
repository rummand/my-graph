/**
 * GBrain contract (owned by the GBrain workstream). Server-only.
 * My Graph's own brain — one per login — stored in Postgres (nodes, edges, sources, chunks, provenance).
 * EVERY read takes a Viewer and returns only what that viewer may see (see schema.ts visibility rules).
 * EVERY write records provenance; a node/edge without provenance is a bug.
 */
import type { Viewer } from "@/lib/auth";
import type { Locator } from "@/db/schema";
import { db } from "@/db";
import { nodes, edges, provenance, sources, chunks, shares, users, wikiPages, reminders } from "@/db/schema";
import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, notInArray, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { embed } from "@/lib/mux";
import {
  canEditItem, canReadItem, edgeSelfReadSql, guestActive, nodeEditSql, nodeReadSql, sourceReadSql, type AccessCtx,
} from "./access";
import {
  clamp01, defaultEdgeStatus, findMergePairs, mergeAliases, namesMatch, narrowerVisibility, normalizeLabel,
  normalizeRelation, noisyOr, rrfFuse, statusAfterReassert, toAnyPrefixTsQuery, toPrefixTsQuery, vectorLiteral,
} from "./pure";
import { ensureSearchIndexesOnce } from "./setup";

export type NodeType = "person" | "place" | "event" | "topic" | "document" | "source";
export type Visibility = "private" | "parents" | "household";
export type EdgeStatus = "confirmed" | "unconfirmed" | "inferred" | "rejected" | "superseded";

export type ProvenanceInput = {
  sourceId?: string | null;
  chunkId?: string | null;
  locator?: Locator;
  quote?: string | null;
  activity: "upload" | "ocr" | "transcription" | "llm_extraction" | "manual_edit" | "inference" | "import";
  agentType: "user" | "model" | "rule";
  agentId: string;
  confidence?: number;
  note?: string;
};

export type GNode = {
  id: string; ownerId: string; type: NodeType; kind?: string | null; label: string; aliases: string[]; summary: string | null;
  props: Record<string, unknown>; startAt: Date | null; endAt: Date | null; timePrecision: "minute" | "day" | "month" | "year" | null;
  visibility: Visibility; sensitive: boolean; createdAt: Date; updatedAt: Date;
};

export type GEdge = {
  id: string; ownerId: string; fromId: string; toId: string; relation: string; props: Record<string, unknown>;
  validFrom: Date | null; validTo: Date | null; confidence: number; status: EdgeStatus; visibility: Visibility; createdAt: Date;
};

export type GProvenance = {
  id: string; sourceId: string | null; sourceTitle: string | null; locator: Locator; quote: string | null;
  activity: ProvenanceInput["activity"]; agentType: ProvenanceInput["agentType"]; agentId: string; confidence: number; note: string | null; createdAt: Date;
};

export type NodeInput = {
  type: NodeType; kind?: string | null; label: string; aliases?: string[]; summary?: string; props?: Record<string, unknown>;
  startAt?: Date | null; endAt?: Date | null; timePrecision?: GNode["timePrecision"];
  visibility?: Visibility; sensitive?: boolean;
};

export type EdgeInput = {
  fromId: string; toId: string; relation: string; props?: Record<string, unknown>;
  validFrom?: Date | null; validTo?: Date | null; confidence?: number; status?: EdgeStatus; visibility?: Visibility;
};

export type SearchHit = {
  kind: "node" | "chunk"; score: number;
  node?: GNode;
  chunk?: { id: string; sourceId: string; sourceTitle: string; text: string; locator: Locator };
};

/* ── Internals ───────────────────────────────────────────────────────────────────────────────────────── */

/** Thrown for problems the caller can act on; `status` maps straight to an HTTP status. */
export class GBrainError extends Error {
  constructor(public status: 400 | 403 | 404 | 409, message: string) {
    super(message);
    this.name = "GBrainError";
  }
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Exec = typeof db | Tx;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string) => UUID.test(s);

const INACTIVE: EdgeStatus[] = ["rejected", "superseded"];
const NOT_SAME_KEY = "gbrainNotSame";

const nodeCols = {
  id: nodes.id, ownerId: nodes.ownerId, householdId: nodes.householdId, type: nodes.type, kind: nodes.kind, label: nodes.label,
  aliases: nodes.aliases, summary: nodes.summary, props: nodes.props, startAt: nodes.startAt, endAt: nodes.endAt,
  timePrecision: nodes.timePrecision, visibility: nodes.visibility, sensitive: nodes.sensitive, mergedInto: nodes.mergedInto,
  createdAt: nodes.createdAt, updatedAt: nodes.updatedAt,
};
type NodeRow = Pick<typeof nodes.$inferSelect, keyof typeof nodeCols>;

const edgeCols = {
  id: edges.id, ownerId: edges.ownerId, householdId: edges.householdId, fromId: edges.fromId, toId: edges.toId,
  relation: edges.relation, props: edges.props, validFrom: edges.validFrom, validTo: edges.validTo,
  confidence: edges.confidence, status: edges.status, supersededBy: edges.supersededBy, visibility: edges.visibility,
  createdAt: edges.createdAt,
};
type EdgeRow = Pick<typeof edges.$inferSelect, keyof typeof edgeCols>;

function toNode(r: NodeRow): GNode {
  return {
    id: r.id, ownerId: r.ownerId, type: r.type, kind: r.kind ?? null, label: r.label, aliases: r.aliases ?? [], summary: r.summary,
    props: r.props ?? {}, startAt: r.startAt, endAt: r.endAt, timePrecision: r.timePrecision, visibility: r.visibility,
    sensitive: r.sensitive, createdAt: r.createdAt, updatedAt: r.updatedAt,
  };
}

function toEdge(r: EdgeRow): GEdge {
  return {
    id: r.id, ownerId: r.ownerId, fromId: r.fromId, toId: r.toId, relation: r.relation, props: r.props ?? {},
    validFrom: r.validFrom, validTo: r.validTo, confidence: r.confidence, status: r.status, visibility: r.visibility,
    createdAt: r.createdAt,
  };
}

/** The viewer's access context (guests: is their access still valid?). */
export async function accessContext(v: Viewer): Promise<AccessCtx> {
  const base = { id: v.id, householdId: v.householdId, role: v.role };
  if (v.role !== "guest") return { ...base, active: true };
  const [u] = await db.select({ exp: users.accessExpiresAt }).from(users).where(eq(users.id, v.id));
  return { ...base, active: guestActive(u?.exp ?? null) };
}

function assertCanWrite(ctx: AccessCtx) {
  if (!ctx.active) throw new GBrainError(403, "Your access has expired.");
  if (ctx.role === "guest") throw new GBrainError(403, "Guests can look at what has been shared with them but can't add to the graph.");
}

function provRow(householdId: string, subjectType: "node" | "edge", subjectId: string, p: ProvenanceInput) {
  if (!p.agentId) throw new GBrainError(400, "Every fact needs to say who or what recorded it.");
  return {
    householdId, subjectType, subjectId,
    sourceId: p.sourceId ?? null, chunkId: p.chunkId ?? null, locator: p.locator ?? {}, quote: p.quote ?? null,
    activity: p.activity, agentType: p.agentType, agentId: p.agentId, confidence: clamp01(p.confidence), note: p.note ?? null,
  };
}

function inList(col: SQL, ids: string[]): SQL {
  if (!ids.length) return sql`false`;
  return sql`${col} in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`;
}

function embedText(n: { label: string; aliases?: string[] | null; summary?: string | null }): string {
  return [n.label, ...(n.aliases ?? [])].join(", ") + (n.summary ? `\n${n.summary}` : "");
}

/** Fire-and-forget: store the node's embedding. mux being down (or a stub) is fine — search falls back to text. */
function embedNodeLater(v: Viewer, id: string, text: string, sensitive: boolean) {
  if (!text.trim()) return;
  void (async () => {
    try {
      const out = await embed([text.slice(0, 8000)], { userId: v.id, agent: "gbrain", sensitive });
      const vec = out?.[0];
      if (vec && vec.length === 1024) await db.update(nodes).set({ embedding: vec }).where(eq(nodes.id, id));
    } catch {
      /* mux unreachable: keyword search still works */
    }
  })();
}

async function embedQuery(v: Viewer, q: string): Promise<number[] | null> {
  try {
    const out = await Promise.race([
      embed([q], { userId: v.id, agent: "gbrain-search" }),
      new Promise<null>((r) => setTimeout(() => r(null), 2500)),
    ]);
    const vec = out?.[0];
    return vec && vec.length === 1024 ? vec : null;
  } catch {
    return null;
  }
}

/** Readable, non-merged nodes by id. */
async function readableNodes(ctx: AccessCtx, ids: string[], ex: Exec = db): Promise<NodeRow[]> {
  const valid = [...new Set(ids)].filter(isUuid);
  if (!valid.length) return [];
  return ex.select(nodeCols).from(nodes).where(and(inArray(nodes.id, valid), isNull(nodes.mergedInto), nodeReadSql(ctx, "nodes")));
}

/** Facts the viewer may see: the edge itself and both endpoints. */
async function visibleEdges(ctx: AccessCtx, where: SQL | undefined, opts: { includeInactive?: boolean; limit?: number } = {}, ex: Exec = db): Promise<EdgeRow[]> {
  const f = alias(nodes, "gf");
  const t = alias(nodes, "gt");
  const q = ex.select(edgeCols).from(edges)
    .innerJoin(f, eq(f.id, edges.fromId))
    .innerJoin(t, eq(t.id, edges.toId))
    .where(and(
      where,
      opts.includeInactive ? undefined : notInArray(edges.status, INACTIVE),
      edgeSelfReadSql(ctx, "edges"),
      isNull(f.mergedInto), isNull(t.mergedInto),
      nodeReadSql(ctx, "gf"), nodeReadSql(ctx, "gt"),
    ))
    .orderBy(desc(edges.confidence), asc(edges.createdAt));
  return opts.limit ? q.limit(opts.limit) : q;
}

async function assertEdgeEditable(ctx: AccessCtx, e: EdgeRow, ex: Exec = db) {
  if (!ctx.active) throw new GBrainError(403, "Your access has expired.");
  if (e.ownerId === ctx.id && ctx.role !== "guest") return;
  const ok = await ex.select({ id: nodes.id }).from(nodes)
    .where(and(inArray(nodes.id, [e.fromId, e.toId]), nodeEditSql(ctx, "nodes"))).limit(1);
  if (!ok.length) throw new GBrainError(403, "You can only change facts in your own graph, or ones shared with you for editing.");
}

/* ── Nodes ───────────────────────────────────────────────────────────────────────────────────────────── */

/** Create a node (or return the existing one when entity resolution finds a match of the same type). */
export async function upsertNode(v: Viewer, input: NodeInput, prov: ProvenanceInput): Promise<{ node: GNode; created: boolean }> {
  const ctx = await accessContext(v);
  assertCanWrite(ctx);
  const label = input.label.trim().replace(/\s+/g, " ");
  if (!normalizeLabel(label)) throw new GBrainError(400, "A name is required.");
  await ensureSearchIndexesOnce();

  const res = await db.transaction(async (tx) => {
    // Serialise resolution per owner and type so two concurrent extractions can't both create "Anna".
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`gbrain:node:${v.id}:${input.type}`}))`);
    const candidates = await tx.select({ id: nodes.id, label: nodes.label, aliases: nodes.aliases }).from(nodes)
      .where(and(eq(nodes.ownerId, v.id), eq(nodes.type, input.type), isNull(nodes.mergedInto)));
    const key = normalizeLabel(label);
    const match = candidates.find((c) => normalizeLabel(c.label) === key)
      ?? candidates.find((c) => namesMatch(c, { label, aliases: input.aliases }));

    if (match) {
      const [cur] = await tx.select(nodeCols).from(nodes).where(eq(nodes.id, match.id)).for("update");
      const patch: Partial<typeof nodes.$inferInsert> = {};
      const aliases = mergeAliases(cur.label, cur.aliases, [label], input.aliases);
      if (aliases.length !== cur.aliases.length) patch.aliases = aliases;
      if (!cur.summary && input.summary?.trim()) patch.summary = input.summary.trim();
      if (!cur.startAt && input.startAt) {
        patch.startAt = input.startAt; patch.endAt = input.endAt ?? null; patch.timePrecision = input.timePrecision ?? null;
      }
      if (input.sensitive && !cur.sensitive) patch.sensitive = true;
      if (input.kind && !cur.kind) patch.kind = input.kind;
      const newProps = Object.fromEntries(Object.entries(input.props ?? {}).filter(([k]) => !(k in cur.props)));
      if (Object.keys(newProps).length) patch.props = { ...cur.props, ...newProps };
      let row = cur;
      if (Object.keys(patch).length) {
        [row] = await tx.update(nodes).set({ ...patch, updatedAt: new Date() }).where(eq(nodes.id, cur.id)).returning(nodeCols);
      }
      await tx.insert(provenance).values(provRow(v.householdId, "node", cur.id, prov));
      return { row, created: false, reembed: "aliases" in patch || "summary" in patch };
    }

    const sensitive = !!input.sensitive;
    const [row] = await tx.insert(nodes).values({
      householdId: v.householdId, ownerId: v.id, type: input.type, kind: input.kind ?? null, label,
      aliases: mergeAliases(label, input.aliases), summary: input.summary?.trim() || null, props: input.props ?? {},
      startAt: input.startAt ?? null, endAt: input.endAt ?? null, timePrecision: input.timePrecision ?? null,
      // Sensitive items default to parents-only; everything else to private.
      visibility: input.visibility ?? (sensitive ? "parents" : "private"), sensitive,
    }).returning(nodeCols);
    await tx.insert(provenance).values(provRow(v.householdId, "node", row.id, prov));
    return { row, created: true, reembed: true };
  });

  if (res.reembed) embedNodeLater(v, res.row.id, embedText(res.row), res.row.sensitive);
  return { node: toNode(res.row), created: res.created };
}

export async function updateNode(v: Viewer, id: string, patch: Partial<NodeInput>, prov: ProvenanceInput): Promise<GNode> {
  const ctx = await accessContext(v);
  if (!isUuid(id)) throw new GBrainError(404, "That item doesn't exist.");
  await ensureSearchIndexesOnce();

  const row = await db.transaction(async (tx) => {
    const [cur] = await tx.select(nodeCols).from(nodes)
      .where(and(eq(nodes.id, id), isNull(nodes.mergedInto), nodeEditSql(ctx, "nodes"))).for("update");
    if (!cur) {
      const readable = await readableNodes(ctx, [id], tx);
      throw readable.length
        ? new GBrainError(403, "You can see this but not change it. Ask its owner to share it with you for editing.")
        : new GBrainError(404, "That item doesn't exist.");
    }
    // Who can see an item (and whether it is sensitive) is the owner's call alone; an edit share doesn't include it.
    const widensAccess = (patch.visibility !== undefined && patch.visibility !== cur.visibility)
      || (patch.sensitive !== undefined && patch.sensitive !== cur.sensitive);
    if (widensAccess && (cur.ownerId !== ctx.id || ctx.role === "guest")) {
      throw new GBrainError(403, "Only the person who added this can change who sees it or whether it is sensitive.");
    }
    const set: Partial<typeof nodes.$inferInsert> = {};
    const label = patch.label?.trim().replace(/\s+/g, " ");
    if (label !== undefined) {
      if (!normalizeLabel(label)) throw new GBrainError(400, "A name is required.");
      if (label !== cur.label) set.label = label;
    }
    const nextLabel = set.label ?? cur.label;
    if (patch.aliases !== undefined || set.label) {
      // A renamed item keeps its old name as an alias, so it is still found by it.
      set.aliases = mergeAliases(nextLabel, patch.aliases ?? cur.aliases, set.label ? [cur.label] : []);
    }
    if (patch.summary !== undefined) set.summary = patch.summary.trim() || null;
    if (patch.type !== undefined) set.type = patch.type;
    if (patch.kind !== undefined) set.kind = patch.kind;
    if (patch.props !== undefined) set.props = { ...cur.props, ...patch.props };
    if (patch.startAt !== undefined) set.startAt = patch.startAt;
    if (patch.endAt !== undefined) set.endAt = patch.endAt;
    if (patch.timePrecision !== undefined) set.timePrecision = patch.timePrecision;
    if (patch.visibility !== undefined) set.visibility = patch.visibility;
    if (patch.sensitive !== undefined) set.sensitive = patch.sensitive;
    const end = set.endAt !== undefined ? set.endAt : cur.endAt;
    const start = set.startAt !== undefined ? set.startAt : cur.startAt;
    if (start && end && end < start) throw new GBrainError(400, "The end can't be before the start.");

    const [updated] = await tx.update(nodes).set({ ...set, updatedAt: new Date() }).where(eq(nodes.id, id)).returning(nodeCols);
    await tx.insert(provenance).values(provRow(v.householdId, "node", id, prov));
    return { updated, reembed: "label" in set || "summary" in set || "aliases" in set };
  });

  if (row.reembed) embedNodeLater(v, id, embedText(row.updated), row.updated.sensitive);
  return toNode(row.updated);
}

/** A readable node. A merged node id resolves to the node it was merged into. */
export async function getNode(v: Viewer, id: string): Promise<GNode | null> {
  if (!isUuid(id)) return null;
  const ctx = await accessContext(v);
  let cur = id;
  for (let hop = 0; hop < 5; hop++) {
    const [r] = await db.select(nodeCols).from(nodes).where(and(eq(nodes.id, cur), nodeReadSql(ctx, "nodes")));
    if (!r) {
      // The merged node itself may be hidden while its successor is visible.
      const [m] = await db.select({ mergedInto: nodes.mergedInto }).from(nodes).where(eq(nodes.id, cur));
      if (!m?.mergedInto) return null;
      cur = m.mergedInto;
      continue;
    }
    if (!r.mergedInto) return toNode(r);
    cur = r.mergedInto;
  }
  return null;
}

export async function listNodes(v: Viewer, opts?: { type?: NodeType; q?: string; limit?: number }): Promise<GNode[]> {
  const ctx = await accessContext(v);
  const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 500);
  const q = opts?.q?.trim();
  const tq = q ? toPrefixTsQuery(q) : null;
  const conds: (SQL | undefined)[] = [isNull(nodes.mergedInto), nodeReadSql(ctx, "nodes")];
  if (opts?.type) conds.push(eq(nodes.type, opts.type));
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    conds.push(tq
      ? sql`(${nodes.search} @@ to_tsquery('simple', ${tq}) or ${nodes.label} ilike ${like})`
      : sql`${nodes.label} ilike ${like}`);
  }
  const order = tq
    ? [sql`ts_rank(coalesce(${nodes.search}, ''::tsvector), to_tsquery('simple', ${tq})) desc`, asc(nodes.label)]
    : [desc(nodes.updatedAt)];
  const rows = await db.select(nodeCols).from(nodes).where(and(...conds)).orderBy(...order).limit(limit);
  return rows.map(toNode);
}

/* ── Facts (edges) ───────────────────────────────────────────────────────────────────────────────────── */

async function addEdgeTx(tx: Tx, v: Viewer, ctx: AccessCtx, input: EdgeInput, prov: ProvenanceInput): Promise<EdgeRow> {
  const relation = normalizeRelation(input.relation);
  if (!relation) throw new GBrainError(400, "Say how the two things are related, for example parent_of or attends.");
  if (input.fromId === input.toId) throw new GBrainError(400, "A fact needs two different things.");
  if (input.status === "rejected" || input.status === "superseded") throw new GBrainError(400, "A new fact can't start out rejected or replaced.");
  const ends = await readableNodes(ctx, [input.fromId, input.toId], tx);
  const from = ends.find((n) => n.id === input.fromId), to = ends.find((n) => n.id === input.toId);
  if (!from || !to) throw new GBrainError(404, "One of the two things in this fact doesn't exist or isn't visible to you.");
  if (input.validFrom && input.validTo && input.validTo < input.validFrom) throw new GBrainError(400, "A fact can't end before it starts.");

  const incoming = clamp01(prov.confidence ?? input.confidence);
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`gbrain:edge:${v.id}:${from.id}:${relation}:${to.id}`}))`);
  const [existing] = await tx.select(edgeCols).from(edges).where(and(
    eq(edges.ownerId, v.id), eq(edges.fromId, from.id), eq(edges.relation, relation), eq(edges.toId, to.id),
    notInArray(edges.status, INACTIVE),
  )).orderBy(asc(edges.createdAt)).limit(1).for("update");

  if (existing) {
    const status = statusAfterReassert(existing.status as "confirmed" | "unconfirmed" | "inferred", { status: input.status, agentType: prov.agentType });
    const [row] = await tx.update(edges).set({
      confidence: status === "confirmed" && prov.agentType === "user" ? 1 : noisyOr(existing.confidence, incoming),
      status,
      validFrom: existing.validFrom ?? input.validFrom ?? null,
      validTo: existing.validTo ?? input.validTo ?? null,
    }).where(eq(edges.id, existing.id)).returning(edgeCols);
    await tx.insert(provenance).values(provRow(v.householdId, "edge", row.id, { ...prov, confidence: incoming }));
    return row;
  }

  const [row] = await tx.insert(edges).values({
    householdId: v.householdId, ownerId: v.id, fromId: from.id, toId: to.id, relation, props: input.props ?? {},
    validFrom: input.validFrom ?? null, validTo: input.validTo ?? null, confidence: incoming,
    status: input.status ?? defaultEdgeStatus(prov),
    visibility: input.visibility ?? narrowerVisibility(from.visibility, to.visibility),
  }).returning(edgeCols);
  await tx.insert(provenance).values(provRow(v.householdId, "edge", row.id, { ...prov, confidence: incoming }));
  return row;
}

/** Assert a fact. Same (from, relation, to) already present → adds provenance and raises confidence instead of duplicating. */
export async function addEdge(v: Viewer, input: EdgeInput, prov: ProvenanceInput): Promise<GEdge> {
  const ctx = await accessContext(v);
  assertCanWrite(ctx);
  if (!isUuid(input.fromId) || !isUuid(input.toId)) throw new GBrainError(404, "One of the two things in this fact doesn't exist or isn't visible to you.");
  const row = await db.transaction((tx) => addEdgeTx(tx, v, ctx, input, prov));
  return toEdge(row);
}

const STATUS_NOTE: Record<EdgeStatus, string> = {
  confirmed: "Confirmed as correct",
  rejected: "Marked as wrong",
  unconfirmed: "Marked as not yet confirmed",
  inferred: "Marked as a guess",
  superseded: "Replaced by a newer fact",
};

/** Confirm / reject / correct a fact; the user's action is recorded as provenance (agentType "user", activity "manual_edit"). */
export async function setEdgeStatus(v: Viewer, id: string, status: EdgeStatus, note?: string): Promise<GEdge> {
  const ctx = await accessContext(v);
  if (!isUuid(id)) throw new GBrainError(404, "That fact doesn't exist.");
  const row = await db.transaction(async (tx) => {
    const [e] = await visibleEdges(ctx, eq(edges.id, id), { includeInactive: true }, tx);
    if (!e) throw new GBrainError(404, "That fact doesn't exist.");
    await assertEdgeEditable(ctx, e, tx);
    const [updated] = await tx.update(edges).set({
      status,
      ...(status === "confirmed" ? { confidence: 1 } : {}),
      ...(status !== "superseded" ? { supersededBy: null } : {}),
    }).where(eq(edges.id, id)).returning(edgeCols);
    await tx.insert(provenance).values(provRow(v.householdId, "edge", id, {
      activity: "manual_edit", agentType: "user", agentId: v.id, confidence: 1, note: note?.trim() || STATUS_NOTE[status],
    }));
    return updated;
  });
  return toEdge(row);
}

/**
 * Correct a fact: the old one is kept as `superseded` (pointing at its replacement) and a confirmed fact with the
 * corrected relation and/or endpoints is asserted by the user. One transaction, provenance on both.
 */
export async function correctEdge(v: Viewer, id: string, change: { relation?: string; fromId?: string; toId?: string; note?: string }): Promise<GEdge> {
  const ctx = await accessContext(v);
  assertCanWrite(ctx);
  if (!isUuid(id)) throw new GBrainError(404, "That fact doesn't exist.");
  const row = await db.transaction(async (tx) => {
    const [old] = await visibleEdges(ctx, eq(edges.id, id), {}, tx);
    if (!old) throw new GBrainError(404, "That fact doesn't exist or has already been replaced.");
    await assertEdgeEditable(ctx, old, tx);
    const next = {
      fromId: change.fromId ?? old.fromId, toId: change.toId ?? old.toId,
      relation: change.relation ? normalizeRelation(change.relation) : old.relation,
    };
    if (next.fromId === old.fromId && next.toId === old.toId && next.relation === old.relation) {
      throw new GBrainError(400, "Nothing changed — pick a different relation or a different person, place or thing.");
    }
    const note = change.note?.trim();
    const created = await addEdgeTx(tx, v, ctx, {
      ...next, props: old.props, validFrom: old.validFrom, validTo: old.validTo, visibility: old.visibility, status: "confirmed",
    }, { activity: "manual_edit", agentType: "user", agentId: v.id, confidence: 1, note: note || "Corrected by hand" });
    await tx.update(edges).set({ status: "superseded", supersededBy: created.id }).where(eq(edges.id, old.id));
    await tx.insert(provenance).values(provRow(v.householdId, "edge", old.id, {
      activity: "manual_edit", agentType: "user", agentId: v.id, confidence: 1, note: note || "Replaced by a corrected fact",
    }));
    return created;
  });
  return toEdge(row);
}

/* ── Reading the graph ───────────────────────────────────────────────────────────────────────────────── */

/** A node with its edges (both directions) and neighbour nodes, all filtered for the viewer. */
export async function neighbourhood(v: Viewer, id: string, depth: 1 | 2 = 1): Promise<{ nodes: GNode[]; edges: GEdge[] }> {
  const ctx = await accessContext(v);
  const [center] = await readableNodes(ctx, [id]);
  if (!center) return { nodes: [], edges: [] };
  const nodeIds = new Set([center.id]);
  const edgeMap = new Map<string, EdgeRow>();
  let frontier = [center.id];
  for (let d = 0; d < depth && frontier.length; d++) {
    const es = await visibleEdges(ctx, or(inArray(edges.fromId, frontier), inArray(edges.toId, frontier)), { limit: 1000 });
    const next: string[] = [];
    for (const e of es) {
      edgeMap.set(e.id, e);
      for (const n of [e.fromId, e.toId]) if (!nodeIds.has(n)) { nodeIds.add(n); next.push(n); }
    }
    frontier = next;
  }
  const rows = await readableNodes(ctx, [...nodeIds]);
  const byId = new Map(rows.map((r) => [r.id, r]));
  return {
    nodes: [center.id, ...[...nodeIds].filter((x) => x !== center.id)].map((x) => byId.get(x)).filter((r): r is NodeRow => !!r).map(toNode),
    edges: [...edgeMap.values()].filter((e) => byId.has(e.fromId) && byId.has(e.toId)).map(toEdge),
  };
}

/** Provenance for many subjects at once (the caller has already checked the subjects are visible). */
async function provenanceFor(ctx: AccessCtx, type: "node" | "edge", ids: string[]): Promise<Map<string, GProvenance[]>> {
  const out = new Map<string, GProvenance[]>();
  if (!ids.length) return out;
  const rows = await db.select({
    id: provenance.id, subjectId: provenance.subjectId, sourceId: provenance.sourceId, sourceTitle: sources.title,
    sourceVisible: sql<boolean>`coalesce(${sourceReadSql(ctx, "sources")}, false)`,
    locator: provenance.locator, quote: provenance.quote, activity: provenance.activity, agentType: provenance.agentType,
    agentId: provenance.agentId, confidence: provenance.confidence, note: provenance.note, createdAt: provenance.createdAt,
  }).from(provenance).leftJoin(sources, eq(sources.id, provenance.sourceId))
    .where(and(eq(provenance.subjectType, type), inArray(provenance.subjectId, ids)))
    .orderBy(desc(provenance.createdAt));
  for (const r of rows) {
    // A source the viewer may not open is named but not quoted.
    const hidden = r.sourceId !== null && !r.sourceVisible;
    const p: GProvenance = {
      id: r.id, sourceId: hidden ? null : r.sourceId, sourceTitle: hidden ? "A source you don't have access to" : r.sourceTitle,
      locator: hidden ? {} : r.locator ?? {}, quote: hidden ? null : r.quote, activity: r.activity, agentType: r.agentType,
      agentId: r.agentId, confidence: r.confidence, note: r.note, createdAt: r.createdAt,
    };
    const list = out.get(r.subjectId);
    if (list) list.push(p); else out.set(r.subjectId, [p]);
  }
  return out;
}

/** Why do we believe this? Every provenance row for a node or edge, newest first, with source titles. */
export async function explain(v: Viewer, subject: { type: "node" | "edge"; id: string }): Promise<GProvenance[]> {
  if (!isUuid(subject.id)) return [];
  const ctx = await accessContext(v);
  if (subject.type === "node") {
    const [n] = await db.select({ id: nodes.id }).from(nodes).where(and(eq(nodes.id, subject.id), nodeReadSql(ctx, "nodes")));
    if (!n) return [];
  } else {
    const [e] = await visibleEdges(ctx, eq(edges.id, subject.id), { includeInactive: true });
    if (!e) return [];
  }
  return (await provenanceFor(ctx, subject.type, [subject.id])).get(subject.id) ?? [];
}

/** Provenance for several visible edges at once (node page). Invisible ids are dropped. */
export async function explainEdges(v: Viewer, edgeIds: string[]): Promise<Record<string, GProvenance[]>> {
  const ids = [...new Set(edgeIds)].filter(isUuid);
  if (!ids.length) return {};
  const ctx = await accessContext(v);
  const visible = await visibleEdges(ctx, inArray(edges.id, ids), { includeInactive: true });
  const map = await provenanceFor(ctx, "edge", visible.map((e) => e.id));
  return Object.fromEntries(visible.map((e) => [e.id, map.get(e.id) ?? []]));
}

/** Display names for provenance agents: household members by id; models and rules by their id. */
export async function agentNames(v: Viewer, provs: Pick<GProvenance, "agentType" | "agentId">[]): Promise<Record<string, string>> {
  const userIds = [...new Set(provs.filter((p) => p.agentType === "user").map((p) => p.agentId))].filter(isUuid);
  const out: Record<string, string> = {};
  if (userIds.length) {
    const rows = await db.select({ id: users.id, name: users.name }).from(users)
      .where(and(inArray(users.id, userIds), eq(users.householdId, v.householdId)));
    for (const r of rows) out[r.id] = r.id === v.id ? `${r.name} (you)` : r.name;
  }
  return out;
}

/** Hybrid search (Postgres full-text + pgvector cosine, fused by RRF) over nodes and source chunks the viewer may see. */
export async function search(v: Viewer, query: string, opts?: { limit?: number; types?: NodeType[] }): Promise<SearchHit[]> {
  const q = query.trim().slice(0, 500);
  if (!q) return [];
  const limit = Math.min(Math.max(opts?.limit ?? 10, 1), 50);
  const per = Math.max(limit * 3, 20);
  const types = opts?.types?.length ? opts.types : null;
  const includeChunks = !types || types.includes("document") || types.includes("source");
  const [ctx, qvec] = await Promise.all([accessContext(v), embedQuery(v, q), ensureSearchIndexesOnce()]);
  const vec = qvec ? vectorLiteral(qvec) : null;
  const nodeWhere = and(isNull(nodes.mergedInto), nodeReadSql(ctx, "nodes"), types ? inArray(nodes.type, types) : undefined);

  const nodeText = async (tq: string) => (await db.select({ id: nodes.id }).from(nodes)
    .where(and(nodeWhere, sql`${nodes.search} @@ to_tsquery('simple', ${tq})`))
    .orderBy(sql`ts_rank(${nodes.search}, to_tsquery('simple', ${tq})) desc`).limit(per)).map((r) => r.id);
  const chunkText = async (tq: string) => (await db.select({ id: chunks.id }).from(chunks)
    .innerJoin(sources, eq(sources.id, chunks.sourceId))
    .where(and(sourceReadSql(ctx, "sources"),
      sql`coalesce(${chunks.search}, to_tsvector('simple', ${chunks.text})) @@ to_tsquery('simple', ${tq})`))
    .orderBy(sql`ts_rank(coalesce(${chunks.search}, to_tsvector('simple', ${chunks.text})), to_tsquery('simple', ${tq})) desc`)
    .limit(per)).map((r) => r.id);
  const withFallback = async (fn: (tq: string) => Promise<string[]>) => {
    const all = toPrefixTsQuery(q);
    if (!all) return [];
    const hits = await fn(all);
    const any = toAnyPrefixTsQuery(q);
    return hits.length || !any || any === all ? hits : fn(any);
  };

  const [nText, nVec, cText, cVec] = await Promise.all([
    withFallback(nodeText),
    vec ? db.select({ id: nodes.id }).from(nodes).where(and(nodeWhere, isNotNull(nodes.embedding)))
      .orderBy(sql`${nodes.embedding} <=> ${vec}::vector`).limit(per).then((r) => r.map((x) => x.id)) : Promise.resolve([]),
    includeChunks ? withFallback(chunkText) : Promise.resolve([]),
    includeChunks && vec ? db.select({ id: chunks.id }).from(chunks).innerJoin(sources, eq(sources.id, chunks.sourceId))
      .where(and(sourceReadSql(ctx, "sources"), isNotNull(chunks.embedding)))
      .orderBy(sql`${chunks.embedding} <=> ${vec}::vector`).limit(per).then((r) => r.map((x) => x.id)) : Promise.resolve([]),
  ]);

  const tag = (kind: "node" | "chunk", ids: string[]) => ids.map((id) => ({ key: `${kind}:${id}`, item: { kind, id } }));
  const fused = rrfFuse([tag("node", nText), tag("node", nVec), tag("chunk", cText), tag("chunk", cVec)]).slice(0, limit);

  const nodeIds = fused.filter((f) => f.item.kind === "node").map((f) => f.item.id);
  const chunkIds = fused.filter((f) => f.item.kind === "chunk").map((f) => f.item.id);
  const [nodeRows, chunkRows] = await Promise.all([
    nodeIds.length ? db.select(nodeCols).from(nodes).where(inArray(nodes.id, nodeIds)) : Promise.resolve([] as NodeRow[]),
    chunkIds.length ? db.select({
      id: chunks.id, sourceId: chunks.sourceId, sourceTitle: sources.title, text: chunks.text, locator: chunks.locator,
    }).from(chunks).innerJoin(sources, eq(sources.id, chunks.sourceId)).where(inArray(chunks.id, chunkIds)) : Promise.resolve([]),
  ]);
  const nMap = new Map(nodeRows.map((r) => [r.id, toNode(r)]));
  const cMap = new Map(chunkRows.map((r) => [r.id, { ...r, locator: r.locator ?? {} }]));
  const hits: SearchHit[] = [];
  for (const f of fused) {
    const score = Math.round(f.score * 1e6) / 1e6;
    if (f.item.kind === "node") { const node = nMap.get(f.item.id); if (node) hits.push({ kind: "node", score, node }); }
    else { const chunk = cMap.get(f.item.id); if (chunk) hits.push({ kind: "chunk", score, chunk }); }
  }
  return hits;
}

/** Events (nodes with startAt) in a window, for the timeline. `personIds` filters to events involving those people. */
export async function timeline(v: Viewer, opts: { from?: Date; to?: Date; personIds?: string[]; topicIds?: string[]; limit?: number }): Promise<{ events: GNode[]; involves: { eventId: string; personId: string }[] }> {
  const ctx = await accessContext(v);
  const limit = Math.min(Math.max(opts.limit ?? 500, 1), 2000);
  const conds: (SQL | undefined)[] = [isNotNull(nodes.startAt), isNull(nodes.mergedInto), nodeReadSql(ctx, "nodes")];
  if (opts.from) conds.push(sql`coalesce(${nodes.endAt}, ${nodes.startAt}) >= ${opts.from.toISOString()}::timestamptz`);
  if (opts.to) conds.push(sql`${nodes.startAt} <= ${opts.to.toISOString()}::timestamptz`);

  const linkedTo = async (ids: string[] | undefined) => {
    if (!ids) return;
    const ok = (await readableNodes(ctx, ids)).map((r) => r.id);
    conds.push(ok.length ? sql`exists (select 1 from edges le where le.status not in ('rejected', 'superseded')
      and ${edgeSelfReadSql(ctx, "le")}
      and ((le.from_id = ${nodes.id} and ${inList(sql`le.to_id`, ok)}) or (le.to_id = ${nodes.id} and ${inList(sql`le.from_id`, ok)})))` : sql`false`);
  };
  await linkedTo(opts.personIds?.length ? opts.personIds : undefined);
  await linkedTo(opts.topicIds?.length ? opts.topicIds : undefined);

  const rows = await db.select(nodeCols).from(nodes).where(and(...conds)).orderBy(asc(nodes.startAt), asc(nodes.label)).limit(limit);
  const eventIds = rows.map((r) => r.id);
  const involves: { eventId: string; personId: string }[] = [];
  if (eventIds.length) {
    const es = await visibleEdges(ctx, or(inArray(edges.fromId, eventIds), inArray(edges.toId, eventIds)));
    const eventSet = new Set(eventIds);
    const others = [...new Set(es.flatMap((e) => [e.fromId, e.toId]).filter((x) => !eventSet.has(x)))];
    const people = others.length
      ? new Set((await db.select({ id: nodes.id }).from(nodes).where(and(inArray(nodes.id, others), eq(nodes.type, "person")))).map((r) => r.id))
      : new Set<string>();
    const seen = new Set<string>();
    for (const e of es) {
      const pair = eventSet.has(e.fromId) && people.has(e.toId) ? [e.fromId, e.toId]
        : eventSet.has(e.toId) && people.has(e.fromId) ? [e.toId, e.fromId] : null;
      if (pair && !seen.has(pair.join("|"))) { seen.add(pair.join("|")); involves.push({ eventId: pair[0], personId: pair[1] }); }
    }
  }
  return { events: rows.map(toNode), involves };
}

/** The whole visible graph (capped), for the graph view. */
export async function graph(v: Viewer, opts?: { limit?: number; centerId?: string }): Promise<{ nodes: GNode[]; edges: GEdge[] }> {
  const limit = Math.min(Math.max(opts?.limit ?? 300, 1), 1000);
  if (opts?.centerId) {
    const n = await neighbourhood(v, opts.centerId, 2);
    const keep = new Set(n.nodes.slice(0, limit).map((x) => x.id));
    return { nodes: n.nodes.filter((x) => keep.has(x.id)), edges: n.edges.filter((e) => keep.has(e.fromId) && keep.has(e.toId)) };
  }
  const ctx = await accessContext(v);
  // Prefer well-connected nodes, then recent ones.
  const degree = sql`(select count(*) from edges de where (de.from_id = ${nodes.id} or de.to_id = ${nodes.id}) and de.status not in ('rejected', 'superseded'))`;
  const rows = await db.select(nodeCols).from(nodes).where(and(isNull(nodes.mergedInto), nodeReadSql(ctx, "nodes")))
    .orderBy(sql`${degree} desc`, desc(nodes.updatedAt)).limit(limit);
  const ids = rows.map((r) => r.id);
  const es = ids.length ? await visibleEdges(ctx, and(inArray(edges.fromId, ids), inArray(edges.toId, ids)), { limit: limit * 4 }) : [];
  return { nodes: rows.map(toNode), edges: es.map(toEdge) };
}

/* ── Entity resolution ───────────────────────────────────────────────────────────────────────────────── */

/** Merge `dropId` into `keepId` (user-approved entity resolution). Edges and provenance move; the dropped node keeps mergedInto. */
export async function mergeNodes(v: Viewer, keepId: string, dropId: string): Promise<GNode> {
  const ctx = await accessContext(v);
  assertCanWrite(ctx);
  if (keepId === dropId) throw new GBrainError(400, "Pick two different items to merge.");
  if (!isUuid(keepId) || !isUuid(dropId)) throw new GBrainError(404, "One of these items doesn't exist.");

  const keepRow = await db.transaction(async (tx) => {
    const both = await tx.select(nodeCols).from(nodes)
      .where(and(inArray(nodes.id, [keepId, dropId]), isNull(nodes.mergedInto), nodeEditSql(ctx, "nodes")))
      .orderBy(asc(nodes.id)).for("update");
    const keep = both.find((n) => n.id === keepId), drop = both.find((n) => n.id === dropId);
    if (!keep || !drop) {
      const readable = await readableNodes(ctx, [keepId, dropId], tx);
      throw readable.length === 2
        ? new GBrainError(403, "You can only merge items you're allowed to edit.")
        : new GBrainError(404, "One of these items doesn't exist or has already been merged.");
    }
    if (keep.type !== drop.type) throw new GBrainError(400, `Only items of the same kind can be merged — this is a ${keep.type} and a ${drop.type}.`);
    // Merging copies names, notes and evidence onto the kept item; across owners that would hand one person's private
    // details to whoever can see the other's item.
    if (keep.ownerId !== drop.ownerId) throw new GBrainError(403, "These belong to different people's graphs, so they can't be merged.");

    // Facts move to the kept node.
    await tx.update(edges).set({ fromId: keepId }).where(eq(edges.fromId, dropId));
    await tx.update(edges).set({ toId: keepId }).where(eq(edges.toId, dropId));
    // A fact between the two merged items now points at itself: retire it (its provenance stays).
    await tx.update(edges).set({ status: "superseded" })
      .where(and(eq(edges.fromId, keepId), eq(edges.toId, keepId), notInArray(edges.status, INACTIVE)));

    // Duplicate facts that now coincide are folded into the oldest one.
    const active = await tx.select(edgeCols).from(edges)
      .where(and(or(eq(edges.fromId, keepId), eq(edges.toId, keepId)), notInArray(edges.status, INACTIVE)))
      .orderBy(asc(edges.createdAt));
    const groups = new Map<string, EdgeRow[]>();
    for (const e of active) {
      const k = `${e.ownerId}|${e.fromId}|${e.relation}|${e.toId}`;
      const g = groups.get(k);
      if (g) g.push(e); else groups.set(k, [e]);
    }
    const rank = { confirmed: 2, unconfirmed: 1, inferred: 0 } as Record<string, number>;
    for (const g of groups.values()) {
      if (g.length < 2) continue;
      const [first, ...dups] = g;
      let conf = first.confidence, status = first.status;
      for (const d of dups) {
        conf = noisyOr(conf, d.confidence);
        if ((rank[d.status] ?? 0) > (rank[status] ?? 0)) status = d.status;
        await tx.update(edges).set({ status: "superseded", supersededBy: first.id }).where(eq(edges.id, d.id));
        // Copy the duplicate's evidence onto the surviving fact.
        await tx.execute(sql`insert into provenance (household_id, subject_type, subject_id, source_id, chunk_id, locator, quote, activity, agent_type, agent_id, confidence, note, created_at)
          select household_id, subject_type, ${first.id}, source_id, chunk_id, locator, quote, activity, agent_type, agent_id, confidence, note, created_at
          from provenance where subject_type = 'edge' and subject_id = ${d.id}`);
      }
      await tx.update(edges).set({ confidence: conf, status }).where(eq(edges.id, first.id));
    }

    // Node evidence moves; anything that pointed at the dropped node follows.
    await tx.update(provenance).set({ subjectId: keepId }).where(and(eq(provenance.subjectType, "node"), eq(provenance.subjectId, dropId)));
    await tx.update(shares).set({ nodeId: keepId }).where(eq(shares.nodeId, dropId));
    await tx.update(nodes).set({ mergedInto: keepId }).where(eq(nodes.mergedInto, dropId));
    await tx.update(users).set({ personNodeId: keepId }).where(eq(users.personNodeId, dropId));
    await tx.update(sources).set({ nodeId: keepId }).where(eq(sources.nodeId, dropId));
    await tx.update(wikiPages).set({ nodeId: keepId }).where(eq(wikiPages.nodeId, dropId));
    await tx.update(reminders).set({ aboutNodeId: keepId }).where(eq(reminders.aboutNodeId, dropId));
    await tx.update(reminders).set({ nodeId: keepId }).where(eq(reminders.nodeId, dropId));

    const { [NOT_SAME_KEY]: _a, ...keepProps } = keep.props as Record<string, unknown>;
    const { [NOT_SAME_KEY]: _b, ...dropProps } = drop.props as Record<string, unknown>;
    const notSame = [...new Set([...asIdList(keep.props[NOT_SAME_KEY]), ...asIdList(drop.props[NOT_SAME_KEY])])].filter((x) => x !== keepId && x !== dropId);
    const [kept] = await tx.update(nodes).set({
      aliases: mergeAliases(keep.label, keep.aliases, [drop.label], drop.aliases),
      summary: keep.summary ?? drop.summary,
      props: { ...dropProps, ...keepProps, ...(notSame.length ? { [NOT_SAME_KEY]: notSame } : {}) },
      startAt: keep.startAt ?? drop.startAt, endAt: keep.startAt ? keep.endAt : drop.endAt,
      timePrecision: keep.startAt ? keep.timePrecision : drop.timePrecision,
      sensitive: keep.sensitive || drop.sensitive,
      // The merged item is never visible to more people than either of the two was.
      visibility: narrowerVisibility(keep.visibility, drop.visibility),
      updatedAt: new Date(),
    }).where(eq(nodes.id, keepId)).returning(nodeCols);
    await tx.update(nodes).set({ mergedInto: keepId, updatedAt: new Date() }).where(eq(nodes.id, dropId));

    const mergeProv = (note: string): ProvenanceInput => ({ activity: "manual_edit", agentType: "user", agentId: v.id, confidence: 1, note });
    await tx.insert(provenance).values([
      provRow(v.householdId, "node", keepId, mergeProv(`Merged "${drop.label}" into this`)),
      provRow(v.householdId, "node", dropId, mergeProv(`Merged into "${keep.label}"`)),
    ]);
    return kept;
  });

  embedNodeLater(v, keepRow.id, embedText(keepRow), keepRow.sensitive);
  return toNode(keepRow);
}

function asIdList(x: unknown): string[] {
  return Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : [];
}

async function suggestions(v: Viewer, opts: { limit: number; focusId?: string }) {
  const ctx = await accessContext(v);
  if (!ctx.active || ctx.role === "guest") return [];
  const rows = await db.select(nodeCols).from(nodes)
    .where(and(isNull(nodes.mergedInto), nodeEditSql(ctx, "nodes"), ne(nodes.type, "source")))
    .orderBy(desc(nodes.updatedAt)).limit(5000);
  const byId = new Map(rows.map((r) => [r.id, toNode(r)]));
  // Only pairs within one owner's graph can be merged (see mergeNodes).
  const pairs = findMergePairs(
    rows.map((r) => ({ id: r.id, type: r.type, label: r.label, aliases: r.aliases, notSame: asIdList(r.props?.[NOT_SAME_KEY]) })),
    { limit: opts.limit * 4, focusId: opts.focusId },
  ).filter((p) => byId.get(p.aId)!.ownerId === byId.get(p.bId)!.ownerId).slice(0, opts.limit);
  return pairs.map((p) => ({ a: byId.get(p.aId)!, b: byId.get(p.bId)!, reason: p.reason, score: p.score }));
}

/** Pairs that look like the same entity, for the user to approve. */
export async function mergeSuggestions(v: Viewer, limit = 20): Promise<{ a: GNode; b: GNode; reason: string; score: number }[]> {
  return suggestions(v, { limit: Math.min(Math.max(limit, 1), 100) });
}

/** Merge suggestions involving one node (`a` is always that node). */
export async function mergeSuggestionsFor(v: Viewer, nodeId: string, limit = 5): Promise<{ a: GNode; b: GNode; reason: string; score: number }[]> {
  if (!isUuid(nodeId)) return [];
  const list = await suggestions(v, { limit, focusId: nodeId });
  return list.map((s) => (s.a.id === nodeId ? s : { ...s, a: s.b, b: s.a }));
}

/** "These are different": stop suggesting this pair. Recorded on both nodes with provenance. */
export async function dismissMergeSuggestion(v: Viewer, aId: string, bId: string): Promise<void> {
  const ctx = await accessContext(v);
  assertCanWrite(ctx);
  if (aId === bId || !isUuid(aId) || !isUuid(bId)) throw new GBrainError(400, "Pick two different items.");
  await db.transaction(async (tx) => {
    const both = await tx.select(nodeCols).from(nodes)
      .where(and(inArray(nodes.id, [aId, bId]), nodeEditSql(ctx, "nodes"))).orderBy(asc(nodes.id)).for("update");
    if (both.length < 2) throw new GBrainError(404, "One of these items doesn't exist or you can't edit it.");
    for (const n of both) {
      const other = both.find((x) => x.id !== n.id)!;
      const list = [...new Set([...asIdList(n.props[NOT_SAME_KEY]), other.id])];
      await tx.update(nodes).set({ props: { ...n.props, [NOT_SAME_KEY]: list } }).where(eq(nodes.id, n.id));
      await tx.insert(provenance).values(provRow(v.householdId, "node", n.id, {
        activity: "manual_edit", agentType: "user", agentId: v.id, confidence: 1, note: `Marked as not the same as "${other.label}"`,
      }));
    }
  });
}

/* ── Access checks ───────────────────────────────────────────────────────────────────────────────────── */

async function accessFacts(v: Viewer, id: string) {
  const ctx = await accessContext(v);
  if (!isUuid(id)) return { ctx, row: undefined, grants: [] };
  const [row] = await db.select({ ownerId: nodes.ownerId, householdId: nodes.householdId, visibility: nodes.visibility, sensitive: nodes.sensitive })
    .from(nodes).where(eq(nodes.id, id));
  const grants = await db.select({ canEdit: shares.canEdit, expiresAt: shares.expiresAt }).from(shares)
    .where(and(eq(shares.nodeId, id), eq(shares.userId, v.id)));
  return { ctx, row, grants };
}

/** Whether the viewer may read / edit a node (ownership, visibility, role, shares, guest expiry). */
// Decided from the stored row only: a caller-supplied ownerId/visibility must never grant access.
export async function canRead(v: Viewer, node: Pick<GNode, "ownerId" | "visibility"> & { id: string }): Promise<boolean> {
  const { ctx, row, grants } = await accessFacts(v, node.id);
  return !!row && canReadItem(ctx, row, grants);
}
export async function canEdit(v: Viewer, node: Pick<GNode, "ownerId"> & { id: string }): Promise<boolean> {
  const { ctx, row, grants } = await accessFacts(v, node.id);
  return !!row && canEditItem(ctx, row, grants);
}

/** Of these node ids, the ones the viewer may read (live, unmerged). */
export async function readableNodeIds(v: Viewer, ids: string[]): Promise<Set<string>> {
  const ctx = await accessContext(v);
  return new Set((await readableNodes(ctx, ids)).map((r) => r.id));
}

/** Of these edge ids, the ones the viewer may read (the edge itself and both endpoints). */
export async function readableEdgeIds(v: Viewer, ids: string[]): Promise<Set<string>> {
  const valid = [...new Set(ids)].filter(isUuid);
  if (!valid.length) return new Set();
  const ctx = await accessContext(v);
  return new Set((await visibleEdges(ctx, inArray(edges.id, valid), { includeInactive: true })).map((e) => e.id));
}
