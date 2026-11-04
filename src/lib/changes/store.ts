/**
 * Change sets on Postgres (server-only): proposing, reading, ticking, dropping. Delivery lives in deliver.ts.
 *
 * Who sees a change set: it is in the viewer's current graph, and it is theirs (they proposed it, or it is waiting
 * for them); a set nobody in particular proposed (a connector, the system) is seen by everyone who may write in the
 * graph. A proposal carries quotes from its evidence, so it is never shown more widely than that.
 */
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNotNull, isNull, notInArray, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { changes, changeSets, edges, graphEvents, nodes, provenance, sources, users } from "@/db/schema";
import type { Viewer } from "@/lib/auth";
import { scopeOf } from "@/lib/graphs/pure";
import { accessContext } from "@/lib/gbrain";
import { edgeSelfReadSql, liveNodeSql, nodeEditSql, nodeReadSql, sourceReadSql, type AccessCtx } from "@/lib/gbrain/access";
import { readableSnapshots } from "@/lib/gbrain/versioning";
import { getMeta } from "@/lib/meta";
import type { ChangeInput, ChangeSetOrigin, ChangeSetView, Receipt } from "./index";
import {
  ALL_OPS, canSeeSet, emptyNow, fingerprintOf, groupReasons, matchExisting, mergeUpdateSet, summarize, summaryOf, toStored, verdictsFor,
  type ChangeRowLike, type Now, type Origin, type RemapEntry, type Resolution, type Verdict,
} from "./pure";

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

/**
 * SQL: everything this set cites (its evidence and every op's receipt) is something this viewer may read — the SQL
 * twin of `evidenceOpen` in ./pure: at least one source, every source readable (sources' own visibility rules), no
 * conversation, no quote without a source, and every existing node an op targets readable too.
 */
function openEvidenceSql(ctx: AccessCtx): SQL {
  const refs = sql`(select ${changeSets.evidence} as r union all select c.receipt from changes c where c.change_set_id = ${changeSets.id})`;
  const has = (k: string) => sql`coalesce(x.r->>${k}, '') <> ''`;
  return sql`(exists (select 1 from ${refs} x where ${has("sourceId")})
    and not exists (select 1 from ${refs} x where ${has("conversationId")}
      or (not ${has("sourceId")} and (coalesce(btrim(x.r->>'quote'), '') <> '' or (x.r->>'messageId') is not null))
      or (${has("sourceId")} and not exists (select 1 from sources s where s.id::text = x.r->>'sourceId' and ${sourceReadSql(ctx, "s")})))
    and not exists (select 1 from changes c join nodes n on n.id = c.node_id where c.change_set_id = ${changeSets.id} and not ${nodeReadSql(ctx, "n")}))`;
}

/** SQL: the change sets this viewer may see in their current graph. */
export async function visibleSql(v: Viewer): Promise<SQL> {
  const mine = or(eq(changeSets.createdBy, v.id), eq(changeSets.forUserId, v.id));
  if (!canWrite(v)) return and(eq(changeSets.graphId, v.graphId), mine)!;
  const nobody = and(isNull(changeSets.createdBy), isNull(changeSets.forUserId));
  const ctx = await accessContext(v);
  return and(eq(changeSets.graphId, v.graphId), or(mine, nobody, openEvidenceSql(ctx)))!;
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
  const [row] = await db.select().from(changeSets).where(and(eq(changeSets.id, id), await visibleSql(v)));
  return row ?? null;
}

/** The graph now, as the viewer sees it, for these change sets' verdicts and names. */
export async function nowFor(v: Viewer, list: ChangeRow[], withMeta: boolean): Promise<Now> {
  const now = emptyNow();
  const ctx = await accessContext(v);
  const nodeIds = new Set<string>(), edgeIds = new Set<string>(), types = new Set<string>();
  const minted = new Set(list.filter((c) => c.op === "addNode" && c.nodeId).map((c) => c.nodeId!));
  for (const c of list) {
    const p = c.payload as Record<string, unknown>;
    if (c.nodeId) nodeIds.add(c.nodeId);
    if (c.edgeId) edgeIds.add(c.edgeId);
    for (const k of ["fromId", "toId", "keepId", "dropId", "aboutNodeId"]) if (isId(p[k])) nodeIds.add(p[k] as string);
    const use = (p.resolution as Record<string, unknown> | undefined)?.use;
    if (isId(use)) nodeIds.add(use);
    if (c.op === "addNode" && typeof p.type === "string") types.add(p.type);
  }
  const snaps = await readableSnapshots(v, { nodeIds: [...nodeIds], edgeIds: [...edgeIds] });
  for (const [id, n] of snaps.nodes) now.nodes.set(id, n);
  for (const [id, e] of snaps.edges) now.edges.set(id, e);

  // The graph index an "Add" is matched against: live, readable nodes of the types the sets add.
  if (types.size && v.graphId) {
    const rows = await db.select({ id: nodes.id, type: nodes.type, kind: nodes.kind, label: nodes.label, aliases: nodes.aliases }).from(nodes)
      .where(and(eq(nodes.graphId, v.graphId), isNull(nodes.mergedInto), inArray(nodes.type, [...types] as never[]), nodeReadSql(ctx, "nodes"), liveNodeSql("nodes"))).limit(20_000);
    now.index = rows.filter((r) => !minted.has(r.id)).map((r) => ({ id: r.id, type: r.type, kind: r.kind ?? null, label: r.label, aliases: r.aliases ?? [] }));
  }
  // What the adds match, and what merged nodes became, as full snapshots (their names show in the review).
  const matched = new Set<string>();
  for (const c of list) {
    if (c.op !== "addNode" || (c.nodeId && now.nodes.has(c.nodeId))) continue;
    const m = matchExisting(c.payload as Record<string, unknown>, now.index);
    if (m.kind === "exists") matched.add(m.node.id);
    else if (m.kind !== "none") for (const n of m.candidates) matched.add(n.id);
  }
  let extra = [...matched].filter((id) => !now.nodes.has(id));
  for (let round = 0; round < 4; round++) {
    for (const n of now.nodes.values()) if (n.mergedInto && !now.nodes.has(n.mergedInto)) extra.push(n.mergedInto);
    extra = [...new Set(extra)].filter((id) => !now.nodes.has(id));
    if (!extra.length) break;
    for (const [id, n] of (await readableSnapshots(v, { nodeIds: extra })).nodes) now.nodes.set(id, n);
    extra = [];
  }
  // The ends of facts the ops touch, so "Lars · leads · EAM Platform" can be named.
  const ends = [...snaps.edges.values()].flatMap((e) => [e.fromId, e.toId]).filter((id) => !now.nodes.has(id));
  if (ends.length) for (const [id, n] of (await readableSnapshots(v, { nodeIds: ends })).nodes) now.nodes.set(id, n);

  // Referenced but not readable: in this graph (no permission) or not at all (gone).
  const unseen = [...nodeIds].filter((id) => !now.nodes.has(id) && !minted.has(id));
  if (unseen.length && v.graphId) {
    for (const r of await db.select({ id: nodes.id }).from(nodes).where(and(inArray(nodes.id, unseen), eq(nodes.graphId, v.graphId)))) now.hidden.add(r.id);
  }
  // Readable things the ops would change but the viewer may not.
  const targets = [...new Set(list.flatMap((c) => {
    const p = c.payload as Record<string, unknown>;
    return c.op === "updateNode" || c.op === "retireNode" ? [c.nodeId] : c.op === "mergeNodes" ? [p.keepId, p.dropId] : [];
  }).filter((id): id is string => isId(id) && now.nodes.has(id)))];
  if (targets.length) {
    const editable = new Set((await db.select({ id: nodes.id }).from(nodes).where(and(inArray(nodes.id, targets), nodeEditSql(ctx, "nodes")))).map((r) => r.id));
    for (const id of targets) if (!editable.has(id)) now.readOnly.add(id);
  }
  // Facts among everything in play (with their ids, so a fact that is already true gets this evidence).
  const inPlay = [...now.nodes.keys()];
  if (inPlay.length) {
    const rows = await db.select({ id: edges.id, fromId: edges.fromId, relation: edges.relation, toId: edges.toId }).from(edges)
      .where(and(inArray(edges.fromId, inPlay), inArray(edges.toId, inPlay), notInArray(edges.status, ["rejected", "superseded"]), edgeSelfReadSql(ctx, "edges")))
      .orderBy(asc(edges.createdAt));
    for (const r of rows) { const k = `${r.fromId}|${r.relation}|${r.toId}`; if (!now.triples.has(k)) now.triples.set(k, r.id); }
  }
  // History of what the ops point at: who retired, merged, removed or changed it, and when.
  const watched = [...new Set([
    ...[...nodeIds].filter((id) => !minted.has(id) && !now.hidden.has(id)),
    ...list.filter((c) => c.op === "updateNode" && c.nodeId).map((c) => c.nodeId!),
  ])];
  if (watched.length && v.graphId) {
    const rows = await db.select({ subjectId: graphEvents.subjectId, kind: graphEvents.kind, field: graphEvents.field, at: graphEvents.at, by: graphEvents.actorName, changeSetId: graphEvents.changeSetId })
      .from(graphEvents).where(and(eq(graphEvents.graphId, v.graphId), inArray(graphEvents.subjectId, watched))).orderBy(desc(graphEvents.at)).limit(3000);
    for (const r of rows) now.events.set(r.subjectId, [...(now.events.get(r.subjectId) ?? []), { kind: r.kind, field: r.field, at: r.at.toISOString(), by: r.by, changeSetId: r.changeSetId }]);
  }
  if (matched.size) now.origins = await originsOf(v, ctx, [...matched]);
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

/**
 * Where existing nodes came from, from history: the proposal that created them (named only when the viewer may see
 * it) and the document behind it, or else the first readable document that names them.
 */
async function originsOf(v: Viewer, ctx: AccessCtx, ids: string[]): Promise<Map<string, Origin>> {
  const out = new Map<string, Origin>();
  if (!v.graphId || !ids.length) return out;
  const created = await db.select({ subjectId: graphEvents.subjectId, changeSetId: graphEvents.changeSetId, at: graphEvents.at, by: graphEvents.actorName })
    .from(graphEvents).where(and(eq(graphEvents.graphId, v.graphId), inArray(graphEvents.subjectId, ids), eq(graphEvents.kind, "created"))).orderBy(asc(graphEvents.at));
  const setIds = [...new Set(created.map((r) => r.changeSetId).filter((x): x is string => !!x))];
  const sets = new Map((setIds.length
    ? await db.select({ id: changeSets.id, title: changeSets.title, evidence: changeSets.evidence }).from(changeSets).where(and(inArray(changeSets.id, setIds), await visibleSql(v)))
    : []).map((s) => [s.id, s]));
  const firstSource = new Map<string, string>();
  for (const r of await db.select({ subjectId: provenance.subjectId, sourceId: provenance.sourceId }).from(provenance)
    .where(and(eq(provenance.subjectType, "node"), inArray(provenance.subjectId, ids), isNotNull(provenance.sourceId))).orderBy(asc(provenance.createdAt))) {
    if (r.sourceId && !firstSource.has(r.subjectId)) firstSource.set(r.subjectId, r.sourceId);
  }
  for (const r of created) {
    if (out.has(r.subjectId)) continue;
    const set = r.changeSetId ? sets.get(r.changeSetId) : undefined;
    const ev = (set?.evidence ?? {}) as Record<string, unknown>;
    const sourceId = (isId(ev.sourceId) ? ev.sourceId : null) ?? firstSource.get(r.subjectId) ?? null;
    out.set(r.subjectId, { changeSetId: set?.id ?? null, changeSetTitle: set?.title ?? null, sourceId, sourceTitle: null, at: r.at.toISOString(), by: r.by });
  }
  for (const id of ids) {
    if (!out.has(id) && firstSource.has(id)) out.set(id, { changeSetId: null, changeSetTitle: null, sourceId: firstSource.get(id)!, sourceTitle: null, at: null, by: null });
  }
  const srcIds = [...new Set([...out.values()].map((o) => o.sourceId).filter((x): x is string => !!x))];
  if (srcIds.length) {
    const titles = new Map((await db.select({ id: sources.id, title: sources.title }).from(sources).where(and(inArray(sources.id, srcIds), sourceReadSql(ctx, "sources")))).map((s) => [s.id, s.title]));
    for (const o of out.values()) {
      if (!o.sourceId) continue;
      if (titles.has(o.sourceId)) o.sourceTitle = titles.get(o.sourceId)!;
      else o.sourceId = null; // not the viewer's to read: say nothing about it
    }
  }
  return out;
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
  // Partly delivered sets point at their follow-up and back; a link is named only when the viewer may see that set.
  const linkOf = (s: SetRow, k: "restIn" | "restOf") => { const x = (s.evidence ?? {})[k]; return isId(x) ? x : null; };
  const linkIds = [...new Set(sets.flatMap((s) => [linkOf(s, "restIn"), linkOf(s, "restOf")]).filter((x): x is string => !!x))];
  const linked = new Map((linkIds.length
    ? await db.select({ id: changeSets.id, title: changeSets.title, status: changeSets.status }).from(changeSets).where(and(inArray(changeSets.id, linkIds), await visibleSql(v)))
    : []).map((r) => [r.id, r]));
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
    const reasons = s.status === "draft" ? verdictsFor(list.map(asLike), now, { includedOnly: true, setId: s.id, baseAt: s.baseAt }) : {};
    for (const [id, r] of Object.entries(reasons)) verdicts[id] = r.verdict;
    const remapped = Array.isArray((s.evidence ?? {}).remapped) ? ((s.evidence ?? {}).remapped as RemapEntry[]) : [];
    return {
      id: s.id, title: s.title, description: s.description, status: s.status, origin: s.origin as ChangeSetOrigin,
      createdAt: s.createdAt, deliveredAt: s.deliveredAt, createdByName: s.createdBy ? names.get(s.createdBy) ?? null : null,
      fingerprint: s.fingerprint,
      restIn: linked.get(linkOf(s, "restIn") ?? "") ?? null,
      restOf: linked.get(linkOf(s, "restOf") ?? "") ?? null,
      changes: list.map((c) => ({
        id: c.id, seq: c.seq, op: c.op, summary: summaryOf(asLike(c), nameOf, rel), note: c.note, receipt: (c.receipt ?? {}) as Receipt,
        included: c.included, nodeId: c.nodeId, edgeId: c.edgeId, payload: c.payload as Record<string, unknown>,
      })),
      verdicts,
      ...(s.status === "draft" ? { reasons, summary: summarize(list, reasons), groups: groupReasons(list, reasons) } : {}),
      ...(remapped.length ? { remapped } : {}),
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
    await visibleSql(v),
    opts.status && opts.status !== "all" ? eq(changeSets.status, opts.status) : undefined,
    opts.origin && ORIGINS.includes(opts.origin) ? eq(changeSets.origin, opts.origin) : undefined,
  );
  const rows = await db.select().from(changeSets).where(where).orderBy(desc(changeSets.createdAt)).limit(limit);
  return views(v, rows);
}

/** How many proposals wait for this viewer (nav badge, Today). */
export async function waitingCount(v: Viewer): Promise<number> {
  if (!member(v)) return 0;
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(changeSets).where(and(await visibleSql(v), eq(changeSets.status, "draft")));
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
  return updateChanges(v, setId, { changeIds: [changeId], included });
}

/**
 * Tick, untick or decide several ops at once (a group's one-click resolution, or one op's own control). A resolution
 * is stored on the op (`payload.resolution`; null clears it), so it is fingerprinted like a tick: an approval made
 * before it is stale. Returns null when the set or none of the ops is the viewer's to change.
 */
export async function updateChanges(v: Viewer, setId: string, input: { changeIds: string[]; included?: boolean; resolution?: Resolution | null; resolutions?: Record<string, Resolution | null> }): Promise<{ fingerprint: string } | null> {
  const row = await loadRow(v, setId);
  if (!row) return null;
  if (row.status !== "draft") throw new ChangeError(409, "This proposal has already been decided.");
  const ids = [...new Set(input.changeIds)].filter(isId);
  if (!ids.length) return null;
  for (const r of [input.resolution, ...Object.values(input.resolutions ?? {})]) if (r?.use && !isId(r.use)) throw new ChangeError(400, "That isn't something in the graph.");
  return db.transaction(async (tx) => {
    const hit = await tx.select().from(changes).where(and(inArray(changes.id, ids), eq(changes.changeSetId, row.id))).for("update");
    if (!hit.length) return null;
    for (const c of hit) {
      const patch: Partial<typeof changes.$inferInsert> = {};
      if (typeof input.included === "boolean") patch.included = input.included;
      const given = input.resolutions && c.id in input.resolutions ? input.resolutions[c.id] : input.resolution;
      if (given !== undefined) {
        const payload = { ...((c.payload ?? {}) as Record<string, unknown>) };
        const r = given ? cleanResolution(given) : null;
        if (r) payload.resolution = r; else delete payload.resolution;
        patch.payload = payload;
      }
      if (Object.keys(patch).length) await tx.update(changes).set(patch).where(eq(changes.id, c.id));
    }
    const all = await tx.select().from(changes).where(eq(changes.changeSetId, row.id));
    const fingerprint = fingerprintOf(all);
    await tx.update(changeSets).set({ fingerprint, updatedAt: new Date() }).where(eq(changeSets.id, row.id));
    return { fingerprint };
  });
}

function cleanResolution(r: Resolution): Resolution | null {
  const out: Resolution = {};
  if (r.use) out.use = r.use;
  else if (r.asNew) out.asNew = true;
  if (r.follow) out.follow = true;
  if (r.keep === "graph" || r.keep === "proposal") out.keep = r.keep;
  return Object.keys(out).length ? out : null;
}

export { loadRow };

/* ── Folding a repeated proposal into the one already waiting ────────────────────────────────────────── */

/**
 * Cross-graph propagation: when "Update <name>" already waits in this graph for the same linked node, a newer edit
 * on the other side folds into it (newer fields win, props merge) instead of opening another proposal. The ops are
 * re-signed (fingerprint), so an approval made before the newer edit is refused as stale. Returns the set's id, or
 * null when nothing is waiting (the caller then proposes afresh).
 */
export async function amendPendingUpdate(v: Viewer, p: { identityId: string; nodeId: string; set: Record<string, unknown>; note?: (merged: Record<string, unknown>) => string; title?: string }): Promise<string | null> {
  if (!member(v) || !isId(p.nodeId)) return null;
  return db.transaction(async (tx) => {
    const [hit] = await tx.select({ setId: changeSets.id, changeId: changes.id, payload: changes.payload }).from(changeSets)
      .innerJoin(changes, eq(changes.changeSetId, changeSets.id))
      .where(and(
        eq(changeSets.graphId, v.graphId), eq(changeSets.status, "draft"), eq(changeSets.origin, "automation"),
        or(eq(changeSets.forUserId, v.id), eq(changeSets.createdBy, v.id)),
        sql`${changeSets.evidence}->'locator'->>'kind' = 'cross-graph-link'`,
        sql`${changeSets.evidence}->'locator'->>'identityId' = ${p.identityId}`,
        eq(changes.op, "updateNode"), eq(changes.nodeId, p.nodeId),
      ))
      .orderBy(desc(changeSets.createdAt)).limit(1).for("update");
    if (!hit) return null;
    const payload = (hit.payload ?? {}) as Record<string, unknown>;
    const merged = mergeUpdateSet((payload.set as Record<string, unknown>) ?? {}, p.set);
    await tx.update(changes).set({ payload: { ...payload, set: merged }, included: true, ...(p.note ? { note: p.note(merged).slice(0, 1000) } : {}) }).where(eq(changes.id, hit.changeId));
    const all = await tx.select().from(changes).where(eq(changes.changeSetId, hit.setId));
    await tx.update(changeSets).set({ fingerprint: fingerprintOf(all), updatedAt: new Date(), ...(p.title ? { title: p.title.slice(0, 200) } : {}) }).where(eq(changeSets.id, hit.setId));
    return hit.setId;
  });
}

/* ── What a reviewer needs next to a proposal ────────────────────────────────────────────────────────── */

export type ReviewContext = {
  /** Things the ops touch, as they are now (only what the viewer may see). */
  nodes: Record<string, { label: string; type: string; kind: string | null; summary: string | null; startAt: string | null; endAt: string | null; visibility: string; props: Record<string, unknown> }>;
  edges: Record<string, { fromId: string; toId: string; relation: string; status: string; confidence: number }>;
  /** Labels for relation keys the ops use. */
  relations: Record<string, string>;
  /** Kind labels by `type:key`. */
  kinds: Record<string, string>;
  /** Titles of the sources the receipts point at (readable ones only). */
  sources: Record<string, string>;
  canDeliver: boolean;
};

export async function reviewContext(v: Viewer, cs: ChangeSetView): Promise<ReviewContext> {
  const rows = cs.changes.map((c) => ({ ...c, changeSetId: cs.id })) as unknown as ChangeRow[];
  const now = await nowFor(v, rows, cs.status === "draft");
  // A delivered set's adds that used existing things link to those.
  if (cs.remapped?.length) for (const [id, n] of (await readableSnapshots(v, { nodeIds: cs.remapped.map((r) => r.to) })).nodes) now.nodes.set(id, n);
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
  return { nodes, edges, relations, kinds, sources: sourcesOut, canDeliver: canWrite(v) };
}
