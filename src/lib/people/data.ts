/**
 * People reads (server). Direct drizzle queries with local access checks (see access.ts) so the people pages work
 * while gbrain's read API is being built; every query filters by the viewer.
 */
import { and, desc, eq, gte, inArray, isNull, lte, notInArray, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { edges, nodes, observations, provenance, reminders, shares, sources, users } from "@/db/schema";
import type { Viewer } from "@/lib/auth";
import { findRelation, getMeta, type Meta } from "@/lib/meta";
import { CATEGORY_LABELS } from "@/lib/meta/types";
import { scopeOf } from "@/lib/graphs/pure";
import { canModify, canSee, isParentRole, visibleWhere } from "./access";
import { attentionItems, nextBirthday } from "./attention";
import { normaliseCircle } from "./circles";
import { memberCircle, relationsToCenter, relationToYou, type PathEdge, type PathNode } from "./relpath";
import { memberSelfNodes } from "@/lib/graphs/self";
import type {
  CenterOption, Citation, FeedItem, Observation, PeopleOverview, PersonProfile, PersonSummary, RelationshipGroup,
} from "./types";

type NodeRow = typeof nodes.$inferSelect;
type EdgeRow = typeof edges.$inferSelect;

const DEAD_EDGE = ["rejected", "superseded"];
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/**
 * The viewer's own person node in the current graph: their self node (`viewer.personNodeId`, set in every graph),
 * else a person node they own with their name.
 */
export async function viewerPersonId(v: Viewer): Promise<string | null> {
  if (v.personNodeId) return v.personNodeId;
  const [row] = await db.select({ id: nodes.id }).from(nodes).where(and(eq(nodes.graphId, v.graphId), eq(nodes.ownerId, v.id), eq(nodes.type, "person"),
    isNull(nodes.mergedInto), sql`lower(${nodes.label}) = lower(${v.name})`)).limit(1);
  return row?.id ?? null;
}

/** Visible, unmerged nodes of the given types. */
export async function visibleNodes(v: Viewer, types: NodeRow["type"][], limit = 5000): Promise<NodeRow[]> {
  return db.select().from(nodes).where(and(inArray(nodes.type, types), isNull(nodes.mergedInto), visibleWhere(v, nodes)))
    .orderBy(nodes.label).limit(limit);
}

/** A single visible node, or null. */
export async function visibleNode(v: Viewer, id: string): Promise<NodeRow | null> {
  const [row] = await db.select().from(nodes).where(and(eq(nodes.id, id), isNull(nodes.mergedInto), visibleWhere(v, nodes)));
  return row ?? null;
}

/** Visible live edges touching any of the ids (both endpoints must also be visible — checked by callers). */
async function edgesTouching(v: Viewer, ids: string[], relations?: string[]): Promise<EdgeRow[]> {
  if (ids.length === 0) return [];
  return db.select().from(edges).where(and(
    or(inArray(edges.fromId, ids), inArray(edges.toId, ids)),
    notInArray(edges.status, DEAD_EDGE as EdgeRow["status"][]),
    relations ? inArray(edges.relation, relations) : undefined,
    visibleWhere(v, edges),
  ));
}

/** Person nodes of the current members of this graph (their self nodes; in the family graph: the household). */
async function memberPersonIds(v: Viewer): Promise<Set<string>> {
  return new Set((await memberSelfNodes(v.graphId)).values());
}

function circleFor(meta: Meta, n: Pick<NodeRow, "kind">, relCategory: string | undefined, isMember: boolean, graphKind: Viewer["graphKind"]): string {
  const k = meta.kind("person", n.kind);
  if (k?.circle) return normaliseCircle(k.circle);
  const byCat: Record<string, string> = { family: "family", school: "school", care: "care", social: "social", work: "work" };
  if (relCategory && byCat[relCategory]) return normaliseCircle(byCat[relCategory]);
  // A fellow member with no recorded relation sits where the graph puts its people.
  return normaliseCircle(isMember ? memberCircle(graphKind) : null);
}

type Built = {
  meta: Meta;
  people: PersonSummary[];
  byId: Map<string, PersonSummary>;
  nodesById: Map<string, NodeRow>;
  centerId: string | null;
  viewerNodeId: string | null;
  members: Set<string>;
};

/** Everything the overview needs, computed for one centre (default: the viewer). */
async function buildPeople(v: Viewer, opts: { centerId?: string | null; now?: Date } = {}): Promise<Built> {
  const now = opts.now ?? new Date();
  const [meta, persons, viewerNodeId, members] = await Promise.all([
    getMeta(v), visibleNodes(v, ["person"]), viewerPersonId(v), memberPersonIds(v),
  ]);
  const nodesById = new Map(persons.map((n) => [n.id, n]));
  const ids = persons.map((p) => p.id);
  const centerId = opts.centerId && nodesById.has(opts.centerId) ? opts.centerId : viewerNodeId && nodesById.has(viewerNodeId) ? viewerNodeId : null;
  const since90 = new Date(now.getTime() - 90 * 86400_000);

  const [edgeRows, wbRows, contactRows, eventRows, reminderRows] = ids.length === 0 ? [[], [], [], [], []] as const : await Promise.all([
    edgesTouching(v, ids),
    // last 8 wellbeing scores per person
    (async () => {
      const ranked = db.select({
        personNodeId: observations.personNodeId, score: observations.score, at: observations.at, note: observations.note,
        sensitive: observations.sensitive,
        rn: sql<number>`row_number() over (partition by ${observations.personNodeId} order by ${observations.at} desc)`.as("rn"),
      }).from(observations).where(and(inArray(observations.personNodeId, ids), eq(observations.kind, "wellbeing"),
        sql`${observations.score} is not null`, visibleWhere(v, observations))).as("ranked");
      return db.select().from(ranked).where(lte(ranked.rn, 8));
    })(),
    db.select({
      personNodeId: observations.personNodeId,
      last: sql<Date>`max(${observations.at})`.mapWith((x: string | Date) => new Date(x)),
      n90: sql<number>`count(*) filter (where ${observations.at} >= ${since90.toISOString()})`.mapWith(Number),
    }).from(observations).where(and(inArray(observations.personNodeId, ids), eq(observations.kind, "contact"), lte(observations.at, now), visibleWhere(v, observations)))
      .groupBy(observations.personNodeId),
    // events involving people (event → person), only visible events in the past
    db.select({ personId: edges.toId, at: nodes.startAt }).from(edges).innerJoin(nodes, eq(nodes.id, edges.fromId))
      .where(and(eq(edges.relation, "involves"), inArray(edges.toId, ids), notInArray(edges.status, DEAD_EDGE as EdgeRow["status"][]),
        eq(nodes.type, "event"), isNull(nodes.mergedInto), lte(nodes.startAt, now), visibleWhere(v, edges), visibleWhere(v, nodes))),
    db.select({ about: reminders.aboutNodeId, n: sql<number>`count(*)`.mapWith(Number) }).from(reminders)
      .where(and(eq(reminders.ownerId, v.id), eq(reminders.done, false), inArray(reminders.aboutNodeId, ids))).groupBy(reminders.aboutNodeId),
  ]);

  const liveEdges: PathEdge[] = edgeRows.filter((e) => nodesById.has(e.fromId) && nodesById.has(e.toId))
    .map((e) => ({ id: e.id, fromId: e.fromId, toId: e.toId, relation: e.relation, status: e.status }));
  const pathNodes = new Map<string, PathNode>(persons.map((p) => [p.id, { id: p.id, label: p.label, type: p.type, kind: p.kind }]));
  const rel = centerId ? relationsToCenter(meta.model, centerId, pathNodes, liveEdges, { centerIsViewer: centerId === viewerNodeId }) : new Map();
  // Circle fallback uses the relation to the viewer, not to a re-centred child.
  const relToViewer = viewerNodeId && viewerNodeId !== centerId && nodesById.has(viewerNodeId)
    ? relationsToCenter(meta.model, viewerNodeId, pathNodes, liveEdges, { centerIsViewer: true }) : rel;

  const wb = new Map<string, { score: number; at: string; note: string | null; sensitive: boolean }[]>();
  for (const r of wbRows) {
    const list = wb.get(r.personNodeId) ?? wb.set(r.personNodeId, []).get(r.personNodeId)!;
    list.push({ score: r.score!, at: new Date(r.at).toISOString(), note: r.note, sensitive: r.sensitive });
  }
  const contacts = new Map(contactRows.map((c) => [c.personNodeId, c]));
  const lastEvent = new Map<string, Date>();
  const events90 = new Map<string, number>();
  for (const e of eventRows) {
    if (!e.at) continue;
    const cur = lastEvent.get(e.personId);
    if (!cur || e.at > cur) lastEvent.set(e.personId, e.at);
    if (e.at >= since90) events90.set(e.personId, (events90.get(e.personId) ?? 0) + 1);
  }
  const rem = new Map(reminderRows.map((r) => [r.about, r.n]));

  const people: PersonSummary[] = persons.map((p) => {
    const kind = meta.kind("person", p.kind);
    const c = contacts.get(p.id);
    const ev = lastEvent.get(p.id);
    const lastContact = c && (!ev || c.last >= ev) ? { at: c.last, src: "contact" as const } : ev ? { at: ev, src: "event" as const } : null;
    const birthday = typeof p.props.birthday === "string" ? p.props.birthday : null;
    const nb = nextBirthday(birthday, now);
    const r = rel.get(p.id) ?? null;
    return {
      id: p.id, label: p.label, kind: p.kind, kindLabel: kind?.label ?? null,
      circle: circleFor(meta, p, relToViewer.get(p.id)?.category, members.has(p.id), v.graphKind),
      visibility: p.visibility, sensitive: p.sensitive, ownerId: p.ownerId,
      householdMember: members.has(p.id), isViewer: p.id === viewerNodeId,
      relation: r, lastContactAt: iso(lastContact?.at), lastContactSource: lastContact?.src ?? null,
      contactCount90: (c?.n90 ?? 0) + (events90.get(p.id) ?? 0),
      wellbeing: (wb.get(p.id) ?? []).reverse(),
      birthday, nextBirthday: nb ? { date: ymd(nb.date), daysUntil: nb.daysUntil, turning: nb.turning } : null,
      openReminders: rem.get(p.id) ?? 0, createdAt: p.createdAt.toISOString(),
    };
  });
  return { meta, people, byId: new Map(people.map((p) => [p.id, p])), nodesById, centerId, viewerNodeId, members };
}

/** GET /api/people and the /people page. `centerId` re-centres the circles on someone (e.g. a child). */
export async function peopleOverview(v: Viewer, opts: { centerId?: string | null; now?: Date } = {}): Promise<PeopleOverview> {
  const now = opts.now ?? new Date();
  const b = await buildPeople(v, { ...opts, now });
  const centers: CenterOption[] = [];
  if (b.viewerNodeId && b.byId.has(b.viewerNodeId)) centers.push({ id: b.viewerNodeId, label: b.byId.get(b.viewerNodeId)!.label, isViewer: true });
  for (const p of b.people) {
    if (p.id === b.viewerNodeId) continue;
    if (b.members.has(p.id) || p.kind === "child" || p.kind === "partner") centers.push({ id: p.id, label: p.label, isViewer: false });
  }
  const center = b.centerId ? centers.find((c) => c.id === b.centerId) ?? { id: b.centerId, label: b.byId.get(b.centerId)!.label, isViewer: b.centerId === b.viewerNodeId } : null;
  const attention = attentionItems(b.people.filter((p) => !p.isViewer).map((p) => {
    const last = p.wellbeing[p.wellbeing.length - 1];
    return {
      id: p.id, label: p.label, kind: p.kind, circle: p.circle, createdAt: new Date(p.createdAt),
      lastContactAt: p.lastContactAt ? new Date(p.lastContactAt) : null, birthday: p.birthday, householdMember: p.householdMember,
      latestWellbeing: last ? { score: last.score, at: new Date(last.at), note: last.note } : null,
    };
  }), now);
  return {
    center, centers, people: b.people, attention,
    kinds: b.meta.kindsFor("person").map((k) => ({ key: k.key, label: k.label, circle: k.circle })),
    generatedAt: now.toISOString(),
  };
}

/* ── Profile ──────────────────────────────────────────────────────────────────────────────────────────── */

async function citationsFor(v: Viewer, subjectType: "node" | "edge", ids: string[]): Promise<Map<string, Citation[]>> {
  const out = new Map<string, Citation[]>();
  if (ids.length === 0) return out;
  const rows = await db.select({
    subjectId: provenance.subjectId, sourceId: provenance.sourceId, activity: provenance.activity, agentType: provenance.agentType,
    confidence: provenance.confidence, createdAt: provenance.createdAt, locator: provenance.locator,
    sourceTitle: sources.title, srcOwner: sources.ownerId, srcHh: sources.householdId, srcGraph: sources.graphId, srcVis: sources.visibility, srcSensitive: sources.sensitive,
  }).from(provenance).leftJoin(sources, eq(sources.id, provenance.sourceId))
    .where(and(eq(provenance.subjectType, subjectType), inArray(provenance.subjectId, ids), eq(provenance.graphId, v.graphId)))
    .orderBy(desc(provenance.createdAt));
  for (const r of rows) {
    const list = out.get(r.subjectId) ?? out.set(r.subjectId, []).get(r.subjectId)!;
    if (list.length >= 3) continue;
    const seen = (c: Citation) => list.some((x) => x.title === c.title && x.href === c.href);
    const page = r.locator?.page ? `p${r.locator.page}` : undefined;
    if (r.sourceId && r.sourceTitle && canSee(v, { ownerId: r.srcOwner!, householdId: r.srcHh!, graphId: r.srcGraph, visibility: r.srcVis!, sensitive: r.srcSensitive! })) {
      const c = { title: r.sourceTitle, href: `/library/${r.sourceId}`, detail: page, confidence: r.confidence < 1 ? r.confidence : undefined };
      if (!seen(c)) list.push(c);
    } else {
      const who = r.agentType === "user" ? "Added by hand" : r.agentType === "model" ? "Assistant" : "Rule";
      const c = { title: r.sourceId ? "A source you can't see" : who, href: subjectType === "node" ? `/node/${r.subjectId}` : "", detail: r.createdAt.toISOString().slice(0, 10), confidence: r.confidence < 1 ? r.confidence : undefined };
      if (!seen(c)) list.push(c);
    }
  }
  return out;
}

export async function listObservations(v: Viewer, personId: string, opts: { kind?: Observation["kind"]; limit?: number } = {}): Promise<Observation[]> {
  const rows = await db.select({ o: observations, authorName: users.name }).from(observations).leftJoin(users, eq(users.id, observations.ownerId))
    .where(and(eq(observations.personNodeId, personId), opts.kind ? eq(observations.kind, opts.kind) : undefined, visibleWhere(v, observations)))
    .orderBy(desc(observations.at)).limit(opts.limit ?? 300);
  return rows.map(({ o, authorName }) => ({
    id: o.id, personNodeId: o.personNodeId, ownerId: o.ownerId, kind: o.kind, score: o.score, note: o.note, tags: o.tags,
    at: o.at.toISOString(), sourceId: o.sourceId, authorKind: o.authorKind, visibility: o.visibility, sensitive: o.sensitive,
    authorName: o.ownerId === v.id ? "You" : authorName,
  }));
}

/** Attributes and props with sensitive ones removed for children who don't own the node. */
export function redactForViewer(v: Viewer, ownerId: string, attrs: PersonProfile["attributes"], props: Record<string, unknown>) {
  if (scopeOf(v).role !== "child" || ownerId === v.id) return { attributes: attrs, props };
  const hiddenKeys = new Set(attrs.filter((a) => a.sensitive).map((a) => a.key));
  return {
    attributes: attrs.filter((a) => !a.sensitive),
    props: Object.fromEntries(Object.entries(props).filter(([k]) => !hiddenKeys.has(k))),
  };
}

export async function personProfile(v: Viewer, id: string): Promise<PersonProfile | null> {
  const node = await visibleNode(v, id);
  if (!node || node.type !== "person") return null;
  const b = await buildPeople(v);
  const summary = b.byId.get(id)!;
  const meta = b.meta;

  const touching = await edgesTouching(v, [id]);
  const otherIds = [...new Set(touching.map((e) => (e.fromId === id ? e.toId : e.fromId)))];
  const others = otherIds.length ? await db.select().from(nodes).where(and(inArray(nodes.id, otherIds), isNull(nodes.mergedInto), visibleWhere(v, nodes))) : [];
  const otherById = new Map(others.map((n) => [n.id, n]));
  const live = touching.filter((e) => otherById.has(e.fromId === id ? e.toId : e.fromId));
  const [edgeCites, nodeCites, obs, docSources] = await Promise.all([
    citationsFor(v, "edge", live.map((e) => e.id)),
    citationsFor(v, "node", [id]),
    listObservations(v, id),
    (async () => {
      const docIds = others.filter((n) => n.type === "document" || n.type === "source").map((n) => n.id);
      if (!docIds.length) return new Map<string, string>();
      const rows = await db.select({ id: sources.id, nodeId: sources.nodeId }).from(sources).where(and(inArray(sources.nodeId, docIds), visibleWhere(v, sources)));
      return new Map(rows.map((r) => [r.nodeId!, r.id]));
    })(),
  ]);

  const nodeHref = (n: NodeRow) => (docSources.has(n.id) ? `/library/${docSources.get(n.id)}` : n.type === "person" ? `/people/${n.id}` : `/node/${n.id}`);

  // Relationships grouped by meta category (documents/time go to the feed instead).
  const groups = new Map<string, RelationshipGroup>();
  for (const e of live) {
    const out = e.fromId === id;
    const other = otherById.get(out ? e.toId : e.fromId)!;
    const r = findRelation(meta.model, e.relation);
    const category = r?.category ?? "other";
    if (category === "document" || category === "time") continue;
    const g = groups.get(category) ?? groups.set(category, { category, label: CATEGORY_LABELS[category] ?? category, items: [] }).get(category)!;
    const toYou = other.id === b.viewerNodeId && id !== b.viewerNodeId
      ? relationToYou(meta.model, e, { id: node.id, label: node.label, type: node.type, kind: node.kind }) : null;
    g.items.push({
      edgeId: e.id, relation: e.relation, label: meta.relationLabel(e.relation, out ? "out" : "in"), direction: out ? "out" : "in", toYou,
      other: { id: other.id, label: other.label, type: other.type, kind: other.kind, kindLabel: meta.kind(other.type, other.kind)?.label ?? null },
      status: e.status, confidence: e.confidence, citations: edgeCites.get(e.id) ?? [],
    });
  }
  const order = ["family", "close", "social", "school", "care", "work", "place", "other"];
  const relationships = [...groups.values()].sort((a, b2) => order.indexOf(a.category) - order.indexOf(b2.category));

  // Feed: observations, events involving them, documents mentioning them.
  const feed: FeedItem[] = obs.map((o) => ({
    id: `o:${o.id}`, at: o.at, type: "observation" as const, observationKind: o.kind, score: o.score,
    title: obsTitle(o), detail: o.note, href: null,
    citations: o.sourceId ? [{ title: "Source", href: `/library/${o.sourceId}` }] : [{ title: o.authorName ? `Logged by ${o.authorName}` : "Logged by hand", href: "" }],
  }));
  const milestones: PersonProfile["milestones"] = obs.filter((o) => o.kind === "milestone").map((o) => ({ id: o.id, at: o.at, title: o.note ?? "Milestone", href: null, source: "observation" }));
  for (const e of touching) {
    const other = otherById.get(e.fromId === id ? e.toId : e.fromId);
    if (!other) continue;
    if (e.relation === "involves" && other.type === "event" && e.toId === id) {
      const at = other.startAt ?? other.createdAt;
      feed.push({ id: `e:${other.id}`, at: at.toISOString(), type: "event", title: other.label, detail: other.summary, href: `/node/${other.id}`, citations: edgeCites.get(e.id) ?? [] });
      if (other.kind === "milestone") milestones.push({ id: other.id, at: at.toISOString(), title: other.label, href: `/node/${other.id}`, source: "event" });
    } else if ((e.relation === "mentions" || e.relation === "about") && e.toId === id && (other.type === "document" || other.type === "source")) {
      feed.push({ id: `d:${e.id}`, at: (other.startAt ?? e.createdAt).toISOString(), type: "document", title: other.label,
        detail: e.relation === "about" ? "About them" : "Mentions them", href: nodeHref(other), citations: edgeCites.get(e.id) ?? [] });
    }
  }
  feed.sort((a, b2) => b2.at.localeCompare(a.at));
  milestones.sort((a, b2) => b2.at.localeCompare(a.at));

  const { attributes, props } = redactForViewer(v, node.ownerId, meta.attributesFor("person", node.kind), node.props);
  const nodeOptions = (await visibleNodes(v, ["person", "place", "event", "topic"], 2000))
    .filter((n) => n.id !== id).map((n) => ({ id: n.id, label: n.label, type: n.type, kind: n.kind, isViewer: n.id === b.viewerNodeId }))
    .sort((a, c) => Number(c.isViewer) - Number(a.isViewer));

  return {
    person: { ...summary, props, summary: node.summary, aliases: node.aliases, canEdit: await canEditNode(v, node), createdAt: node.createdAt.toISOString() },
    attributes, relationships, observations: obs, milestones, feed: feed.slice(0, 150),
    relationOptions: meta.model.relations.filter((r) => !r.hidden && (r.fromTypes.length === 0 || r.fromTypes.includes("person") || r.toTypes.length === 0 || r.toTypes.includes("person"))),
    kinds: meta.kindsFor("person"), nodeOptions, provenance: nodeCites.get(id) ?? [],
    viewer: { id: v.id, role: v.role, isParent: isParentRole(v) },
  };
}

function obsTitle(o: Observation): string {
  const words: Record<number, string> = { 1: "Struggling", 2: "Low", 3: "OK", 4: "Good", 5: "Thriving" };
  switch (o.kind) {
    case "wellbeing": return o.score ? `Check-in: ${words[o.score] ?? o.score}` : "Check-in";
    case "contact": return o.tags.includes("met") ? "Met" : o.tags.includes("messaged") ? "Messaged" : o.tags.includes("talked") ? "Talked" : "In touch";
    case "milestone": return "Milestone";
    case "health": return "Health note";
    default: return "Note";
  }
}

export async function canEditNode(v: Viewer, node: Pick<NodeRow, "id" | "ownerId" | "householdId" | "graphId" | "visibility" | "sensitive">): Promise<boolean> {
  if (canModify(v, node)) return true;
  const [s] = await db.select({ id: shares.id }).from(shares).where(and(eq(shares.nodeId, node.id), eq(shares.userId, v.id), eq(shares.canEdit, true),
    or(isNull(shares.expiresAt), gte(shares.expiresAt, new Date()))));
  return !!s && canModify(v, node, true);
}

