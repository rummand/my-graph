/**
 * Timeline (server-only): events from GBrain, open reminders and 'added to library' markers, arranged into lanes.
 * Every read goes through the viewer's access rules (GBrain for events/people/topics, the reminders module for
 * reminders, GBrain's source rule for uploads).
 */
import "server-only";
import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { provenance, sources, users } from "@/db/schema";
import type { Viewer } from "@/lib/auth";
import { accessContext, getNode, listNodes, readableNodeIds, timeline, type GNode } from "@/lib/gbrain";
import { sourceReadSql } from "@/lib/gbrain/access";
import { listReminders } from "@/lib/briefs";
import { deriveStatus, familyLane, laneIdsFor, orderLanes, type LaneCandidate, type ProvLite } from "./pure";
import type { TimelineQuery } from "./schemas";
import { FAMILY_LANE, type ItemKind, type Lane, type TimelineData, type TimelineItem, type TopicOption } from "./types";

export type { TimelineData, TimelineItem, Lane, TopicOption } from "./types";

const DEFAULT_LIMIT = 2000;
const DEFAULT_TYPES: ItemKind[] = ["event", "reminder"];

/** Node types that never become timeline events even if they carry a date. */
const NOT_EVENTS = new Set<GNode["type"]>(["person", "source"]);

export async function loadTimeline(v: Viewer, q: TimelineQuery = {}): Promise<TimelineData> {
  const now = new Date();
  const from = q.from ? new Date(q.from) : undefined;
  const to = q.to ? new Date(q.to) : undefined;
  const types = new Set<ItemKind>(q.types?.length ? q.types : DEFAULT_TYPES);
  const personFilter = q.people?.length ? new Set(q.people) : null;
  const topicFilter = q.topics?.length ? q.topics : undefined;
  const limit = q.limit ?? DEFAULT_LIMIT;

  const [tl, members, reminderRows, sourceRows, topicNodes] = await Promise.all([
    types.has("event")
      ? timeline(v, { from, to, personIds: q.people, topicIds: topicFilter, limit })
      : Promise.resolve({ events: [] as GNode[], involves: [] as { eventId: string; personId: string }[] }),
    db.select({ id: users.id, role: users.role, birthYear: users.birthYear, personNodeId: users.personNodeId, name: users.name })
      // Members of the current graph (the household, in the family graph).
      .from(users).where(sql`exists (select 1 from graph_members gm where gm.user_id = ${users.id} and gm.graph_id = ${v.graphId})`),
    types.has("reminder") && v.role !== "guest" ? safe(() => listReminders(v, { limit: 200 }), []) : Promise.resolve([]),
    types.has("source") && !topicFilter ? loadSources(v, from, to) : Promise.resolve([]),
    safe(() => listNodes(v, { type: "topic", limit: 200 }), [] as GNode[]),
  ]);

  const events = tl.events.filter((e) => !NOT_EVENTS.has(e.type) && e.startAt);
  const truncated = tl.events.length >= limit;

  // ── People: household members + everyone involved, restricted to person nodes the viewer may read.
  const involvedBy = new Map<string, string[]>();
  for (const { eventId, personId } of tl.involves) (involvedBy.get(eventId) ?? involvedBy.set(eventId, []).get(eventId)!).push(personId);
  const memberByPerson = new Map(members.filter((m) => m.personNodeId).map((m) => [m.personNodeId!, m]));
  const viewerPersonId = v.personNodeId ?? members.find((m) => m.id === v.id)?.personNodeId ?? null;
  const ownerPerson = new Map(members.map((m) => [m.id, m.personNodeId]));

  const candidateIds = new Set<string>([
    ...memberByPerson.keys(),
    ...tl.involves.map((x) => x.personId),
    ...reminderRows.map((r) => r.aboutNodeId).filter((x): x is string => !!x),
    ...(personFilter ?? []),
  ]);
  const readable = candidateIds.size ? await readableNodeIds(v, [...candidateIds]) : new Set<string>();
  const labels = await personLabels(v, [...readable]);

  const eventCount = new Map<string, number>();
  for (const { personId } of tl.involves) eventCount.set(personId, (eventCount.get(personId) ?? 0) + 1);

  const candidates: LaneCandidate[] = [...readable].filter((id) => labels.has(id)).map((id) => {
    const m = memberByPerson.get(id);
    return {
      id, label: labels.get(id)!, isViewer: id === viewerPersonId, isChild: m?.role === "child", isMember: !!m,
      birthYear: m?.birthYear ?? null, eventCount: eventCount.get(id) ?? 0,
    };
  });
  const people = orderLanes(candidates);
  const personLanes = personFilter ? people.filter((p) => personFilter.has(p.id)) : people;
  const laneSet = new Set(personLanes.map((l) => l.id));

  // ── Status per event from its provenance (one query).
  const provBy = new Map<string, ProvLite[]>();
  if (events.length) {
    const rows = await db.select({ subjectId: provenance.subjectId, activity: provenance.activity, agentType: provenance.agentType })
      .from(provenance).where(and(eq(provenance.subjectType, "node"), inArray(provenance.subjectId, events.map((e) => e.id))));
    for (const r of rows) (provBy.get(r.subjectId) ?? provBy.set(r.subjectId, []).get(r.subjectId)!).push(r);
  }

  const items: TimelineItem[] = [];
  for (const e of events) {
    const personIds = (involvedBy.get(e.id) ?? []).filter((p) => readable.has(p));
    items.push({
      id: `event:${e.id}`, kind: "event", title: e.label, summary: e.summary,
      start: e.startAt!.toISOString(), end: e.endAt && e.endAt > e.startAt! ? e.endAt.toISOString() : null,
      precision: e.timePrecision, status: deriveStatus(e.props, provBy.get(e.id) ?? []),
      laneIds: laneIdsFor(personIds, laneSet), personIds, nodeId: e.id, sourceId: null, sensitive: e.sensitive,
    });
  }

  const eventIds = new Set(events.map((e) => e.id));
  for (const r of reminderRows) {
    if (r.done) continue;
    const due = new Date(r.dueAt);
    if ((from && due < from) || (to && due > to)) continue;
    const about = r.aboutNodeId && readable.has(r.aboutNodeId) ? [r.aboutNodeId] : [];
    if (personFilter && !about.some((p) => personFilter.has(p))) continue;
    if (topicFilter && !(r.nodeId && eventIds.has(r.nodeId))) continue;
    items.push({
      id: `reminder:${r.id}`, kind: "reminder", title: r.title, summary: r.detail, start: r.dueAt, end: null,
      precision: "minute", status: r.createdByKind === "user" ? "confirmed" : "unconfirmed",
      laneIds: laneIdsFor(about, laneSet), personIds: about, nodeId: r.nodeId, sourceId: r.sourceId, sensitive: false,
      overdue: due < now,
    });
  }

  for (const s of sourceRows) {
    const p = ownerPerson.get(s.ownerId);
    const personIds = p && readable.has(p) ? [p] : [];
    if (personFilter && !personIds.some((x) => personFilter.has(x))) continue;
    items.push({
      id: `source:${s.id}`, kind: "source", title: s.title, summary: null, start: s.createdAt.toISOString(), end: null,
      precision: "minute", status: "confirmed", laneIds: laneIdsFor(personIds, laneSet), personIds,
      nodeId: s.nodeId, sourceId: s.id, sensitive: s.sensitive,
    });
  }

  items.sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id));
  const usesFamily = items.some((i) => i.laneIds.includes(FAMILY_LANE));
  const lanes: Lane[] = [...personLanes, ...(!personFilter || usesFamily ? [familyLane()] : [])];
  const topics: TopicOption[] = topicNodes.map((t) => ({ id: t.id, label: t.label }))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));

  return {
    lanes, items, topics, people, truncated,
    from: from?.toISOString() ?? null, to: to?.toISOString() ?? null, generatedAt: now.toISOString(),
  };
}

/** Uploads the viewer may open, as 'added to library' markers. */
async function loadSources(v: Viewer, from?: Date, to?: Date) {
  const ctx = await accessContext(v);
  return db.select({ id: sources.id, title: sources.title, ownerId: sources.ownerId, createdAt: sources.createdAt, nodeId: sources.nodeId, sensitive: sources.sensitive })
    .from(sources)
    .where(and(eq(sources.graphId, v.graphId), eq(sources.kind, "upload"), sourceReadSql(ctx, "sources"),
      from ? gte(sources.createdAt, from) : undefined, to ? lte(sources.createdAt, to) : undefined))
    .orderBy(desc(sources.createdAt)).limit(500);
}

/** Labels of readable person nodes (one list query, then point lookups for any not in the first page). */
async function personLabels(v: Viewer, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!ids.length) return out;
  const want = new Set(ids);
  for (const n of await listNodes(v, { type: "person", limit: 500 })) if (want.has(n.id)) out.set(n.id, n.label);
  const missing = ids.filter((id) => !out.has(id));
  const got = await Promise.all(missing.map((id) => getNode(v, id)));
  // getNode follows merges; only keep exact ids (a merged person's events are re-pointed by GBrain).
  got.forEach((n, i) => { if (n && n.type === "person" && n.id === missing[i]) out.set(n.id, n.label); });
  return out;
}

/** Optional side data must not take the whole timeline down (e.g. reminders module unavailable). */
async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof Response) throw err;
    console.error("[timeline] optional data failed", err);
    return fallback;
  }
}
