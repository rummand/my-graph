/**
 * Reading the graph's history back (server-only): the log, the graph at a moment, what changed between two moments,
 * who last changed a field, checkpoints, and restoring a moment as a proposal. Everything is scoped to the viewer's
 * current graph and filtered by what they may see; history is never rewritten — a restore is a new change set.
 */
import { and, asc, desc, eq, gt, gte, inArray, lte, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { changeSets, checkpoints, graphEvents, provenance, sources, wikiPages } from "@/db/schema";
import type { Viewer } from "@/lib/auth";
import { scopeOf } from "@/lib/graphs/pure";
import { graphsOfUser } from "@/lib/graphs/store";
import { readableSnapshots, readableState, wholeGraph } from "@/lib/gbrain/versioning";
import { pageReadSql } from "@/lib/pages/access";
import { localizeTitle, readerT, type HistoryEvent } from "@/lib/changes";
import { diffStates, isActiveEdge, isLiveNode, rewind, type GraphState, type StateDiff, type StoredEvent } from "./pure";
import { restoreOps } from "./read-pure";
import { getPrefs, getT } from "@/lib/i18n";

/** "4. nov. 2026, 04.19" / "4 Nov 2026, 04:19" in the reader's time zone. */
function formatDateTime(at: Date, locale: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat(locale === "da" ? "da-DK" : "en-GB", { dateStyle: "medium", timeStyle: "short", timeZone }).format(at);
  } catch {
    return at.toISOString().slice(0, 16).replace("T", " ");
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type EventRow = typeof graphEvents.$inferSelect;

function toEvent(r: EventRow): HistoryEvent & { fromNodeId: string | null; toNodeId: string | null; actorId: string | null } {
  return {
    id: r.id, subjectType: r.subjectType, subjectId: r.subjectId, subjectName: r.subjectName, kind: r.kind, field: r.field,
    fromValue: r.fromValue, toValue: r.toValue, actorKind: r.actorKind, actorName: r.actorName, changeSetId: r.changeSetId, context: r.context, at: r.at,
    fromNodeId: r.fromNodeId, toNodeId: r.toNodeId, actorId: r.actorId,
  };
}

/** Of these events, the ones the viewer may read: their subject (or, for a fact, both its ends) is visible to them now. */
async function visibleEvents(v: Viewer, rows: EventRow[]): Promise<EventRow[]> {
  const nodeIds = new Set<string>(), edgeIds = new Set<string>(), wikiIds = new Set<string>();
  for (const r of rows) {
    if (r.subjectType !== "edge" && r.subjectType !== "wiki" && r.subjectType !== "meta") nodeIds.add(r.subjectId);
    if (r.subjectType === "edge") { edgeIds.add(r.subjectId); if (r.fromNodeId) nodeIds.add(r.fromNodeId); if (r.toNodeId) nodeIds.add(r.toNodeId); }
    if (r.subjectType === "wiki") wikiIds.add(r.subjectId);
    if (r.subjectType === "link" && r.fromNodeId) nodeIds.add(r.fromNodeId);
  }
  // A cross-graph link names the other graphs: shown only to someone who is a member of every one of them.
  const hasLinks = rows.some((r) => r.subjectType === "link");
  const myGraphs = hasLinks ? new Set((await graphsOfUser(v).catch(() => [])).map((g) => g.id)) : new Set<string>();
  const inAll = (r: EventRow) => {
    const others = (r.toValue as { otherGraphIds?: unknown } | null)?.otherGraphIds;
    return Array.isArray(others) && others.every((g) => typeof g === "string" && myGraphs.has(g));
  };
  const snaps = await readableSnapshots(v, { nodeIds: [...nodeIds], edgeIds: [...edgeIds] });
  const pages = wikiIds.size
    ? new Set((await db.select({ id: wikiPages.id }).from(wikiPages).where(and(inArray(wikiPages.id, [...wikiIds]), pageReadSql(v)))).map((p) => p.id))
    : new Set<string>();
  const guest = scopeOf(v).role === "guest";
  return rows.filter((r) => {
    if (r.subjectType === "node") return snaps.nodes.has(r.subjectId);
    if (r.subjectType === "edge") return snaps.edges.has(r.subjectId) || (!!r.fromNodeId && !!r.toNodeId && snaps.nodes.has(r.fromNodeId) && snaps.nodes.has(r.toNodeId) && !guest);
    if (r.subjectType === "wiki") return pages.has(r.subjectId);
    if (r.subjectType === "meta") return !guest;
    if (r.subjectType === "link") return !guest && !!r.fromNodeId && snaps.nodes.has(r.fromNodeId) && inAll(r);
    return snaps.nodes.has(r.subjectId);
  });
}

export async function historyFor(v: Viewer, opts: { subjectId?: string; since?: Date; until?: Date; limit?: number; actorId?: string } = {}) {
  if (!v.graphId) return [];
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const about = opts.subjectId && UUID.test(opts.subjectId)
    ? or(eq(graphEvents.subjectId, opts.subjectId), eq(graphEvents.fromNodeId, opts.subjectId), eq(graphEvents.toNodeId, opts.subjectId))
    : undefined;
  if (opts.subjectId && !about) return [];
  const where = and(
    eq(graphEvents.graphId, v.graphId), about,
    opts.since ? gte(graphEvents.at, opts.since) : undefined,
    opts.until ? lte(graphEvents.at, opts.until) : undefined,
    opts.actorId && UUID.test(opts.actorId) ? eq(graphEvents.actorId, opts.actorId) : undefined,
  );
  const out: EventRow[] = [];
  let offset = 0;
  // Read in pages until enough visible events are found (or the log ends).
  for (let round = 0; round < 5 && out.length < limit; round++) {
    const page = await db.select().from(graphEvents).where(where).orderBy(desc(graphEvents.at), desc(graphEvents.id)).limit(limit * 2).offset(offset);
    if (!page.length) break;
    out.push(...(await visibleEvents(v, page)));
    offset += page.length;
    if (page.length < limit * 2) break;
  }
  return out.slice(0, limit).map(toEvent);
}

/* ── The graph at a moment ───────────────────────────────────────────────────────────────────────────── */

/** When the log begins in this graph (null = nothing recorded yet). */
export async function historyStartsAt(v: Viewer): Promise<Date | null> {
  if (!v.graphId) return null;
  const [r] = await db.select({ at: graphEvents.at }).from(graphEvents).where(eq(graphEvents.graphId, v.graphId)).orderBy(asc(graphEvents.at)).limit(1);
  return r?.at ?? null;
}

async function eventsAfter(graphId: string, at: Date): Promise<StoredEvent[]> {
  const rows = await db.select({
    id: graphEvents.id, subjectType: graphEvents.subjectType, subjectId: graphEvents.subjectId, kind: graphEvents.kind, field: graphEvents.field,
    fromValue: graphEvents.fromValue, toValue: graphEvents.toValue, fromNodeId: graphEvents.fromNodeId, toNodeId: graphEvents.toNodeId, at: graphEvents.at,
  }).from(graphEvents).where(and(eq(graphEvents.graphId, graphId), gt(graphEvents.at, at), inArray(graphEvents.subjectType, ["node", "edge"])));
  return rows;
}

/** The graph as the viewer would have seen it at `at` (rewound from now; filtered on the visibility it had then). */
export async function graphAt(v: Viewer, at: Date): Promise<GraphState> {
  if (!v.graphId) return { nodes: new Map(), edges: new Map() };
  const now = await wholeGraph(v);
  const state = at.getTime() >= Date.now() ? now : rewind(now, await eventsAfter(v.graphId, at), at);
  return readableState(v, state);
}

/** Live nodes and active facts only, for display. */
export function liveOnly(s: GraphState): GraphState {
  return { nodes: new Map([...s.nodes].filter(([, n]) => isLiveNode(n))), edges: new Map([...s.edges].filter(([, e]) => isActiveEdge(e))) };
}

/** What changed between two moments (a before b). */
export async function compare(v: Viewer, a: Date, b: Date): Promise<StateDiff> {
  const [x, y] = a <= b ? [a, b] : [b, a];
  const [sa, sb] = await Promise.all([graphAt(v, x), graphAt(v, y)]);
  return diffStates(sa, sb);
}

/* ── Who said so (blame) ─────────────────────────────────────────────────────────────────────────────── */

export type FieldBlame = {
  event: HistoryEvent;
  changeSet: { id: string; title: string; origin: string } | null;
  evidence: { quote: string | null; sourceId: string | null; sourceTitle: string | null; note: string | null } | null;
};

/** The latest change to one field of a node (or the node's creation): who, when, through which proposal, on what evidence. */
export async function whoSaidField(v: Viewer, nodeId: string, field?: string | null): Promise<FieldBlame | null> {
  if (!v.graphId || !UUID.test(nodeId)) return null;
  const snaps = await readableSnapshots(v, { nodeIds: [nodeId] });
  if (!snaps.nodes.has(nodeId)) return null;
  const [row] = await db.select().from(graphEvents)
    .where(and(eq(graphEvents.graphId, v.graphId), eq(graphEvents.subjectId, nodeId),
      field ? or(eq(graphEvents.field, field), eq(graphEvents.kind, "created")) : undefined))
    .orderBy(sql`case when ${graphEvents.field} = ${field ?? ""} then 0 else 1 end`, desc(graphEvents.at)).limit(1);
  if (!row) return null;
  let changeSet: FieldBlame["changeSet"] = null;
  if (row.changeSetId) {
    const [cs] = await db.select({ id: changeSets.id, title: changeSets.title, titleKey: changeSets.titleKey, titleParams: changeSets.titleParams, origin: changeSets.origin, createdBy: changeSets.createdBy, forUserId: changeSets.forUserId, graphId: changeSets.graphId })
      .from(changeSets).where(eq(changeSets.id, row.changeSetId));
    const { canSee } = await import("@/lib/changes/store");
    if (cs && canSee(v, cs)) changeSet = { id: cs.id, title: localizeTitle(cs, await readerT(v)), origin: cs.origin };
  }
  // The provenance written with that change: same moment (a few seconds), this node, this graph.
  const near = new Date(row.at.getTime() - 5000), after = new Date(row.at.getTime() + 5000);
  const [p] = await db.select({ quote: provenance.quote, sourceId: provenance.sourceId, note: provenance.note, sourceTitle: sources.title, sourceGraph: sources.graphId })
    .from(provenance).leftJoin(sources, eq(sources.id, provenance.sourceId))
    .where(and(eq(provenance.graphId, v.graphId), eq(provenance.subjectType, "node"), eq(provenance.subjectId, nodeId), gte(provenance.createdAt, near), lte(provenance.createdAt, after)))
    .orderBy(desc(provenance.createdAt)).limit(1);
  // A source title only when the viewer may read that source (the gbrain explain() rule, approximated: same graph).
  const evidence = p ? { quote: p.quote, sourceId: p.sourceGraph === v.graphId ? p.sourceId : null, sourceTitle: p.sourceGraph === v.graphId ? p.sourceTitle : null, note: p.note } : null;
  return { event: toEvent(row), changeSet, evidence };
}

/* ── Checkpoints ─────────────────────────────────────────────────────────────────────────────────────── */

export type Checkpoint = { id: string; label: string; at: Date; createdAt: Date };

export async function listCheckpoints(v: Viewer): Promise<Checkpoint[]> {
  if (!v.graphId) return [];
  return db.select({ id: checkpoints.id, label: checkpoints.label, at: checkpoints.at, createdAt: checkpoints.createdAt })
    .from(checkpoints).where(eq(checkpoints.graphId, v.graphId)).orderBy(desc(checkpoints.at)).limit(200);
}

export async function createCheckpoint(v: Viewer, input: { label: string; at?: Date }): Promise<Checkpoint | null> {
  if (!v.graphId || !scopeOf(v).canWrite) return null;
  const at = input.at && input.at.getTime() <= Date.now() ? input.at : new Date();
  const [row] = await db.insert(checkpoints).values({ graphId: v.graphId, label: input.label.trim().slice(0, 120), at, createdBy: v.id })
    .returning({ id: checkpoints.id, label: checkpoints.label, at: checkpoints.at, createdAt: checkpoints.createdAt });
  return row;
}

export async function getCheckpoint(v: Viewer, id: string): Promise<Checkpoint | null> {
  if (!v.graphId || !UUID.test(id)) return null;
  const [row] = await db.select({ id: checkpoints.id, label: checkpoints.label, at: checkpoints.at, createdAt: checkpoints.createdAt })
    .from(checkpoints).where(and(eq(checkpoints.id, id), eq(checkpoints.graphId, v.graphId)));
  return row ?? null;
}

/* ── Restoring a moment, as a proposal ───────────────────────────────────────────────────────────────── */

export { restoreOps };

/** Propose going back to `at` (a checkpoint or any moment). Returns the change set, or null when nothing differs. */
export async function proposeRestore(v: Viewer, at: Date, label: string): Promise<{ id: string | null; ops: number; skipped: number }> {
  const [now, then, t, prefs] = await Promise.all([graphAt(v, new Date()), graphAt(v, at), getT(), getPrefs()]);
  const { ops, skipped } = restoreOps(now, then, v.id, t("history.restoreProposal.note"));
  if (!ops.length) return { id: null, ops: 0, skipped };
  const { proposeChanges } = await import("@/lib/changes");
  const r = await proposeChanges(v, {
    title: t("history.restoreProposal.title", { label: label.slice(0, 100) }),
    description: t("history.restoreProposal.description", { date: formatDateTime(at, prefs.locale, prefs.timeZone) }),
    origin: "restore", changes: ops,
  });
  return { id: r?.id ?? null, ops: ops.length, skipped };
}
