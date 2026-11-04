/**
 * Change sets on Postgres (server-only): proposing, reading, ticking, dropping. Delivery lives in deliver.ts.
 *
 * Who sees a change set: it is in the viewer's current graph, and it is theirs (they proposed it, or it is waiting
 * for them); a set nobody in particular proposed (a connector, the system) is seen by everyone who may write in the
 * graph. A proposal carries quotes from its evidence, so it is never shown more widely than that.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { changes, changeSets, users } from "@/db/schema";
import type { Viewer } from "@/lib/auth";
import { scopeOf } from "@/lib/graphs/pure";
import { activeTriples, namesOfType, readableSnapshots } from "@/lib/gbrain/versioning";
import { getMeta } from "@/lib/meta";
import type { ChangeInput, ChangeSetOrigin, ChangeSetView, Receipt } from "./index";
import { ALL_OPS, canSeeSet, emptyNow, fingerprintOf, norm, summaryOf, toStored, verdictsFor, type ChangeRowLike, type Now, type Verdict } from "./pure";

export class ChangeError extends Error {
  constructor(public status: 400 | 403 | 404 | 409 | 422, message: string) { super(message); this.name = "ChangeError"; }
}

export const ORIGINS: ChangeSetOrigin[] = ["person", "assistant", "chat", "connector", "web", "ingest", "automation", "heartbeat", "keeper", "restore"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isId = (s: unknown): s is string => typeof s === "string" && UUID.test(s);

export type SetRow = typeof changeSets.$inferSelect;
export type ChangeRow = typeof changes.$inferSelect;

/** A member working in this graph (guests whose access ended never get this far: requireUser refuses them). */
function member(v: Viewer): boolean {
  return !!v.graphId;
}

export function canWrite(v: Viewer): boolean {
  return member(v) && scopeOf(v).canWrite;
}

/** SQL: the change sets this viewer may see in their current graph. */
export function visibleSql(v: Viewer): SQL {
  const mine = or(eq(changeSets.createdBy, v.id), eq(changeSets.forUserId, v.id));
  const nobody = and(isNull(changeSets.createdBy), isNull(changeSets.forUserId));
  return and(eq(changeSets.graphId, v.graphId), canWrite(v) ? or(mine, nobody) : mine)!;
}

export function canSee(v: Viewer, row: Pick<SetRow, "graphId" | "createdBy" | "forUserId">): boolean {
  return canSeeSet({ id: v.id, graphId: member(v) ? v.graphId : null, canWrite: canWrite(v) }, row);
}

function authorFor(origin: ChangeSetOrigin, v: Viewer): { authorKind: string; authorId: string | null; authorName: string | null } {
  if (origin === "person" || origin === "chat" || origin === "restore") return { authorKind: "person", authorId: v.id, authorName: v.name };
  if (origin === "connector" || origin === "ingest") return { authorKind: "connector", authorId: null, authorName: null };
  return { authorKind: "assistant", authorId: null, authorName: null };
}

/* ── Proposing ───────────────────────────────────────────────────────────────────────────────────────── */

export async function propose(v: Viewer, input: { title: string; description?: string; origin: ChangeSetOrigin; evidence?: Receipt; forUserId?: string; changes: ChangeInput[] }): Promise<{ id: string; nodeIds: Record<number, string> } | null> {
  if (!member(v) || v.role === "guest") return null;
  if (!ORIGINS.includes(input.origin)) throw new ChangeError(400, "Unknown origin.");
  const ops = input.changes.filter((c) => c && ALL_OPS.has(c.op));
  if (!ops.length) return null;
  const title = (input.title || "Proposed changes").trim().slice(0, 200);
  const nodeIds: Record<number, string> = {};
  const rows = ops.map((c, i) => {
    const stored = toStored(c, randomUUID);
    if (c.op === "addNode" && stored.nodeId) nodeIds[i] = stored.nodeId;
    if (stored.nodeId && !isId(stored.nodeId)) stored.nodeId = null;
    if (stored.edgeId && !isId(stored.edgeId)) stored.edgeId = null;
    return { ...stored, seq: i + 1, note: c.note?.slice(0, 1000) ?? null, receipt: (c.receipt ?? {}) as Record<string, unknown>, included: true };
  });
  // Ops that point at nodes added in this set keep those ids (minted above or given by the proposer).
  const author = authorFor(input.origin, v);
  const forUserId = isId(input.forUserId) ? input.forUserId : null;
  const id = await db.transaction(async (tx) => {
    const [set] = await tx.insert(changeSets).values({
      graphId: v.graphId, title, description: input.description?.slice(0, 2000) ?? null, status: "draft", origin: input.origin,
      createdBy: v.id, forUserId, evidence: (input.evidence ?? {}) as Record<string, unknown>,
    }).returning({ id: changeSets.id });
    const inserted = await tx.insert(changes).values(rows.map((r) => ({
      changeSetId: set.id, graphId: v.graphId, seq: r.seq, op: r.op, nodeId: r.nodeId, edgeId: r.edgeId,
      subject: null, payload: r.payload, note: r.note, receipt: r.receipt, included: true, ...author,
    }))).returning();
    await tx.update(changeSets).set({ fingerprint: fingerprintOf(inserted) }).where(eq(changeSets.id, set.id));
    return set.id;
  });
  return { id, nodeIds };
}

/* ── Reading ─────────────────────────────────────────────────────────────────────────────────────────── */

async function loadRow(v: Viewer, id: string): Promise<SetRow | null> {
  if (!isId(id) || !member(v)) return null;
  const [row] = await db.select().from(changeSets).where(and(eq(changeSets.id, id), visibleSql(v)));
  return row ?? null;
}

/** The graph now, as the viewer sees it, for these change sets' verdicts and names. */
export async function nowFor(v: Viewer, list: ChangeRow[], withMeta: boolean): Promise<Now> {
  const now = emptyNow();
  const nodeIds = new Set<string>(), edgeIds = new Set<string>(), types = new Set<string>();
  for (const c of list) {
    const p = c.payload as Record<string, unknown>;
    if (c.nodeId) nodeIds.add(c.nodeId);
    if (c.edgeId) edgeIds.add(c.edgeId);
    for (const k of ["fromId", "toId", "keepId", "dropId", "aboutNodeId"]) if (isId(p[k])) nodeIds.add(p[k] as string);
    if (c.op === "addNode" && typeof p.type === "string") types.add(p.type);
  }
  const snaps = await readableSnapshots(v, { nodeIds: [...nodeIds], edgeIds: [...edgeIds] });
  for (const [id, n] of snaps.nodes) now.nodes.set(id, n);
  for (const [id, e] of snaps.edges) now.edges.set(id, e);
  // The ends of facts the ops touch, so "Lars · leads · EAM Platform" can be named.
  const ends = [...snaps.edges.values()].flatMap((e) => [e.fromId, e.toId]).filter((id) => !now.nodes.has(id));
  if (ends.length) for (const [id, n] of (await readableSnapshots(v, { nodeIds: ends })).nodes) now.nodes.set(id, n);
  for (const t of await activeTriples(v, [...nodeIds])) now.triples.add(t);
  if (types.size) {
    for (const n of await namesOfType(v, [...types])) {
      for (const name of [n.label, ...(n.aliases ?? [])]) now.names.set(`${n.type}:${norm(name)}`, n.id);
    }
  }
  if (withMeta) {
    try {
      const m = await getMeta(v);
      for (const k of m.kinds) now.meta.add(`kinds:${k.nodeType}:${k.key}`);
      for (const r of m.relations) now.meta.add(`relations:${r.key}`);
      for (const a of m.attributes) now.meta.add(`attributes:${a.nodeType}:${a.kindKey ?? "*"}:${a.key}`);
    } catch { /* model unavailable: model ops read as outstanding */ }
  }
  return now;
}

async function relationLabels(v: Viewer): Promise<(key: string) => string> {
  try {
    const m = await getMeta(v);
    return (k) => m.relationLabel(k);
  } catch {
    return (k) => k.replace(/_/g, " ");
  }
}

const asLike = (c: ChangeRow): ChangeRowLike => ({ id: c.id, seq: c.seq, op: c.op, nodeId: c.nodeId, edgeId: c.edgeId, payload: c.payload as Record<string, unknown>, included: c.included });

async function views(v: Viewer, sets: SetRow[]): Promise<ChangeSetView[]> {
  if (!sets.length) return [];
  const rows = await db.select().from(changes).where(inArray(changes.changeSetId, sets.map((s) => s.id))).orderBy(changes.changeSetId, changes.seq);
  const drafts = new Set(sets.filter((s) => s.status === "draft").map((s) => s.id));
  const now = await nowFor(v, rows, rows.some((r) => drafts.has(r.changeSetId) && (r.op === "addKind" || r.op === "addRelationType" || r.op === "addAttribute")));
  const rel = await relationLabels(v);
  const creators = [...new Set(sets.map((s) => s.createdBy).filter((x): x is string => !!x))];
  const names = new Map((creators.length ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, creators)) : []).map((u) => [u.id, u.name]));
  const bySet = new Map<string, ChangeRow[]>();
  for (const r of rows) bySet.set(r.changeSetId, [...(bySet.get(r.changeSetId) ?? []), r]);
  return sets.map((s) => {
    const list = bySet.get(s.id) ?? [];
    const added = new Map(list.filter((c) => c.op === "addNode" && c.nodeId).map((c) => [c.nodeId!, String((c.payload as Record<string, unknown>).label ?? "")]));
    const nodeName = (id: string) => now.nodes.get(id)?.label ?? added.get(id) ?? null;
    // A fact reads as "Lars · leads · EAM Platform" (both ends must be readable, as now.edges already ensures).
    const nameOf = (id: string) => {
      const e = now.edges.get(id);
      return e ? `${nodeName(e.fromId) ?? "…"} · ${rel(e.relation)} · ${nodeName(e.toId) ?? "…"}` : nodeName(id);
    };
    const verdicts: Record<string, Verdict> = {};
    if (s.status === "draft") for (const [id, r] of Object.entries(verdictsFor(list.map(asLike), now))) verdicts[id] = r.verdict;
    return {
      id: s.id, title: s.title, description: s.description, status: s.status, origin: s.origin as ChangeSetOrigin,
      createdAt: s.createdAt, deliveredAt: s.deliveredAt, createdByName: s.createdBy ? names.get(s.createdBy) ?? null : null,
      fingerprint: s.fingerprint,
      changes: list.map((c) => ({
        id: c.id, seq: c.seq, op: c.op, summary: summaryOf(asLike(c), nameOf, rel), note: c.note, receipt: (c.receipt ?? {}) as Receipt,
        included: c.included, nodeId: c.nodeId, edgeId: c.edgeId, payload: c.payload as Record<string, unknown>,
      })),
      verdicts,
    };
  });
}

export async function getOne(v: Viewer, id: string): Promise<ChangeSetView | null> {
  const row = await loadRow(v, id);
  if (!row) return null;
  return (await views(v, [row]))[0] ?? null;
}

export async function list(v: Viewer, opts: { status?: "draft" | "delivered" | "abandoned" | "all"; origin?: ChangeSetOrigin; limit?: number } = {}): Promise<ChangeSetView[]> {
  if (!member(v)) return [];
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const where = and(
    visibleSql(v),
    opts.status && opts.status !== "all" ? eq(changeSets.status, opts.status) : undefined,
    opts.origin && ORIGINS.includes(opts.origin) ? eq(changeSets.origin, opts.origin) : undefined,
  );
  const rows = await db.select().from(changeSets).where(where).orderBy(desc(changeSets.createdAt)).limit(limit);
  return views(v, rows);
}

/** How many proposals wait for this viewer (nav badge, Today). */
export async function waitingCount(v: Viewer): Promise<number> {
  if (!member(v)) return 0;
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(changeSets).where(and(visibleSql(v), eq(changeSets.status, "draft")));
  return r?.n ?? 0;
}

/* ── Deciding (other than delivering) ────────────────────────────────────────────────────────────────── */

export async function abandon(v: Viewer, id: string): Promise<boolean> {
  const row = await loadRow(v, id);
  if (!row || row.status !== "draft") return false;
  // Dropping is a decision too, but anyone the proposal is for may say no — including someone who can't write.
  const r = await db.update(changeSets).set({ status: "abandoned", updatedAt: new Date() })
    .where(and(eq(changeSets.id, row.id), eq(changeSets.status, "draft"))).returning({ id: changeSets.id });
  return r.length > 0;
}

/** Tick or untick one op. Changes the fingerprint, so an approval made before this is stale. */
export async function setIncluded(v: Viewer, setId: string, changeId: string, included: boolean): Promise<{ fingerprint: string } | null> {
  const row = await loadRow(v, setId);
  if (!row) return null;
  if (row.status !== "draft") throw new ChangeError(409, "This proposal has already been decided.");
  if (!isId(changeId)) return null;
  return db.transaction(async (tx) => {
    const r = await tx.update(changes).set({ included }).where(and(eq(changes.id, changeId), eq(changes.changeSetId, row.id))).returning({ id: changes.id });
    if (!r.length) return null;
    const all = await tx.select().from(changes).where(eq(changes.changeSetId, row.id));
    const fingerprint = fingerprintOf(all);
    await tx.update(changeSets).set({ fingerprint, updatedAt: new Date() }).where(eq(changeSets.id, row.id));
    return { fingerprint };
  });
}

export { loadRow };

/* ── What a reviewer needs next to a proposal ────────────────────────────────────────────────────────── */

export type ReviewContext = {
  /** Things the ops touch, as they are now (only what the viewer may see). */
  nodes: Record<string, { label: string; type: string; kind: string | null; summary: string | null; startAt: string | null; endAt: string | null; visibility: string; props: Record<string, unknown> }>;
  edges: Record<string, { fromId: string; toId: string; relation: string; status: string; confidence: number }>;
  /** Labels for relation keys the ops use. */
  relations: Record<string, string>;
  /** Kind labels by `type:key`. */
  kinds: Record<string, string>;
  /** Why each op got its verdict (a key under changes.why). */
  why: Record<string, string>;
  /** Titles of the sources the receipts point at (readable ones only). */
  sources: Record<string, string>;
  canDeliver: boolean;
};

export async function reviewContext(v: Viewer, cs: ChangeSetView): Promise<ReviewContext> {
  const rows = cs.changes.map((c) => ({ ...c, changeSetId: cs.id })) as unknown as ChangeRow[];
  const now = await nowFor(v, rows, cs.status === "draft");
  const why: Record<string, string> = {};
  if (cs.status === "draft") for (const [id, r] of Object.entries(verdictsFor(cs.changes, now))) why[id] = r.why;
  const nodes: ReviewContext["nodes"] = {};
  for (const [id, n] of now.nodes) nodes[id] = { label: n.label, type: n.type, kind: n.kind, summary: n.summary, startAt: n.startAt, endAt: n.endAt, visibility: n.visibility, props: n.props };
  const edges: ReviewContext["edges"] = {};
  for (const [id, e] of now.edges) edges[id] = { fromId: e.fromId, toId: e.toId, relation: e.relation, status: e.status, confidence: e.confidence };
  const relations: Record<string, string> = {}, kinds: Record<string, string> = {};
  try {
    const m = await getMeta(v);
    const keys = new Set(cs.changes.flatMap((c) => [c.payload.relation, (c.payload.set as Record<string, unknown> | undefined)?.relation]).filter((k): k is string => typeof k === "string"));
    for (const e of Object.values(edges)) keys.add(e.relation);
    for (const k of keys) relations[k] = m.relationLabel(k);
    for (const k of m.kinds) kinds[`${k.nodeType}:${k.key}`] = k.label;
  } catch { /* labels fall back to keys */ }
  const sourceIds = [...new Set(cs.changes.map((c) => c.receipt?.sourceId).filter(isId))];
  const sourcesOut: Record<string, string> = {};
  if (sourceIds.length) {
    const { sources: src } = await import("@/db/schema");
    const { accessContext } = await import("@/lib/gbrain");
    const { sourceReadSql } = await import("@/lib/gbrain/access");
    const ctx = await accessContext(v);
    for (const s of await db.select({ id: src.id, title: src.title }).from(src).where(and(inArray(src.id, sourceIds), sourceReadSql(ctx, "sources")))) sourcesOut[s.id] = s.title;
  }
  return { nodes, edges, relations, kinds, why, sources: sourcesOut, canDeliver: canWrite(v) };
}
