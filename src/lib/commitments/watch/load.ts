/**
 * What the checks read (server-only). Every read is as a person (a Viewer) in one graph and goes through GBrain's
 * access rules — nodes (nodeReadSql), edges (edgeSelfReadSql + both ends readable) and sources (sourceVisibleTo) — so
 * a check never sees, quotes or proposes from anything that person couldn't open themselves.
 */
import { and, desc, eq, gte, inArray, isNull, lte, ne, notInArray, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { corpusRules, edges, nodes, provenance, sources, users } from "@/db/schema";
import type { Viewer } from "@/lib/auth";
import { accessContext } from "@/lib/gbrain";
import { edgeSelfReadSql, liveNodeSql, nodeReadSql } from "@/lib/gbrain/access";
import { sourceVisibleTo } from "@/lib/ingest/access";
import { memberSelfNodes } from "@/lib/graphs/self";
import type { CommitmentView } from "../pure";
import { ADULT_WORDS, PRESENCE_WORDS, pairKey, type Slot } from "./clash";
import { classifySource, type Statement } from "./contradict";
import type { Evidence, FulfilCommitment } from "./fulfil";
import { nameVariants } from "./text";

const DAY = 86_400_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEAD = ["rejected", "superseded"] as const;
const list = (x: unknown): string[] => (Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : typeof x === "string" ? [x] : []);
const num = (x: unknown): number | null => {
  const n = typeof x === "number" ? x : typeof x === "string" && x.trim() ? Number(x) : NaN;
  return Number.isFinite(n) ? n : null;
};
const ids = (xs: string[]) => sql.join(xs.map((x) => sql`${x}`), sql`, `);

/* ── Slots for the clash check ───────────────────────────────────────────────────────────────────────── */

export type SlotWorld = {
  slots: Slot[];
  names: Map<string, string>;
  caretakers: Record<string, string[]>;
  related: Set<string>;
};

/** Open appointments and events in the next `days` (and the last day), with who must be there and where. */
export async function loadSlots(v: Viewer, now: Date, days = 60): Promise<SlotWorld> {
  const ctx = await accessContext(v);
  const from = new Date(now.getTime() - DAY), to = new Date(now.getTime() + days * DAY);
  const rows = await db.select({
    id: nodes.id, type: nodes.type, kind: nodes.kind, label: nodes.label, props: nodes.props, startAt: nodes.startAt, endAt: nodes.endAt,
    precision: nodes.timePrecision, ownerId: nodes.ownerId,
  }).from(nodes).where(and(
    eq(nodes.graphId, v.graphId), isNull(nodes.mergedInto), liveNodeSql("nodes"), nodeReadSql(ctx, "nodes"),
    gte(nodes.startAt, from), lte(nodes.startAt, to),
    or(
      eq(nodes.type, "event"),
      and(eq(nodes.type, "commitment"), sql`coalesce(${nodes.props}->>'status', 'open') = 'open'`, sql`coalesce(${nodes.props}->>'kind', ${nodes.kind}) = 'appointment'`),
    ),
  )).limit(1500);
  const world: SlotWorld = { slots: [], names: new Map(), caretakers: {}, related: new Set() };
  if (!rows.length) return world;
  const itemIds = rows.map((r) => r.id);

  const es = await db.select({ id: edges.id, fromId: edges.fromId, toId: edges.toId, relation: edges.relation }).from(edges).where(and(
    eq(edges.graphId, v.graphId), notInArray(edges.status, [...DEAD]), edgeSelfReadSql(ctx, "edges"),
    inArray(edges.relation, ["involves", "responsible_for", "about", "with", "happened_at", "located_at", "clashes_with", "arises_from"]),
    or(inArray(edges.fromId, itemIds), inArray(edges.toId, itemIds)),
  ));
  const otherIds = [...new Set(es.flatMap((e) => [e.fromId, e.toId]))];
  const others = otherIds.length ? await db.select({ id: nodes.id, type: nodes.type, label: nodes.label, props: nodes.props }).from(nodes)
    .where(and(inArray(nodes.id, otherIds), isNull(nodes.mergedInto), nodeReadSql(ctx, "nodes"))) : [];
  const node = new Map(others.map((n) => [n.id, n]));
  for (const n of others) if (n.type === "person") world.names.set(n.id, n.label);

  // Who looks after whom (parent_of between readable people).
  const people = others.filter((n) => n.type === "person").map((n) => n.id);
  if (people.length) {
    const pe = await db.select({ fromId: edges.fromId, toId: edges.toId }).from(edges).where(and(
      eq(edges.graphId, v.graphId), eq(edges.relation, "parent_of"), notInArray(edges.status, [...DEAD]), edgeSelfReadSql(ctx, "edges"), inArray(edges.toId, people),
    ));
    const parentIds = [...new Set(pe.map((e) => e.fromId))];
    const readableParents = parentIds.length ? new Set((await db.select({ id: nodes.id, label: nodes.label }).from(nodes)
      .where(and(inArray(nodes.id, parentIds), isNull(nodes.mergedInto), nodeReadSql(ctx, "nodes")))).map((p) => { world.names.set(p.id, p.label); return p.id; })) : new Set<string>();
    for (const e of pe) if (readableParents.has(e.fromId)) (world.caretakers[e.toId] ??= []).push(e.fromId);
  }

  // The first source each item was read from (for the receipt).
  const prov = await db.select({ subjectId: provenance.subjectId, sourceId: provenance.sourceId, quote: provenance.quote }).from(provenance)
    .innerJoin(sources, eq(sources.id, provenance.sourceId))
    .where(and(eq(provenance.graphId, v.graphId), eq(provenance.subjectType, "node"), inArray(provenance.subjectId, itemIds), sourceVisibleTo(v)))
    .orderBy(provenance.createdAt);
  const firstSource = new Map<string, { sourceId: string; quote: string | null }>();
  for (const p of prov) if (p.sourceId && !firstSource.has(p.subjectId)) firstSource.set(p.subjectId, { sourceId: p.sourceId, quote: p.quote });

  const itemSet = new Set(itemIds);
  for (const e of es) {
    if ((e.relation === "clashes_with" || e.relation === "arises_from") && itemSet.has(e.fromId) && itemSet.has(e.toId)) world.related.add(pairKey(e.fromId, e.toId));
  }
  for (const r of rows) {
    const mine = es.filter((e) => e.fromId === r.id || e.toId === r.id);
    const other = (e: (typeof es)[number]) => node.get(e.fromId === r.id ? e.toId : e.fromId);
    const who = new Set<string>();
    let place: Slot["place"] = null;
    for (const e of mine) {
      const o = other(e);
      if (!o) continue;
      const personRel = r.type === "event" ? e.relation === "involves" && e.fromId === r.id
        : (e.relation === "responsible_for" && e.toId === r.id) || (e.relation === "about" && e.fromId === r.id);
      if (o.type === "person" && personRel) who.add(o.id);
      if (!place && ["happened_at", "located_at", "with", "about"].includes(e.relation) && (o.type === "place" || o.type === "organization")) {
        const lat = num(o.props?.lat ?? o.props?.latitude), lon = num(o.props?.lon ?? o.props?.lng ?? o.props?.longitude);
        if (lat !== null && lon !== null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) place = { lat, lon, label: o.label };
      }
    }
    if (!who.size || !r.startAt) continue;
    const allDay = r.precision === "day" || r.precision === "month" || r.precision === "year";
    const multiDay = !!r.endAt && r.endAt.getTime() - r.startAt.getTime() >= 20 * 60 * 60_000;
    const src = firstSource.get(r.id);
    const isChildThing = [...who].some((p) => (world.caretakers[p] ?? []).length > 0);
    world.slots.push({
      id: r.id, label: r.label, start: r.startAt, end: r.endAt, allDay, people: [...who], place,
      origin: r.type === "commitment" ? "commitment" : "event",
      presence: allDay && (multiDay || PRESENCE_WORDS.test(r.label) || PRESENCE_WORDS.test(String(r.kind ?? ""))),
      needsAdult: !allDay && isChildThing && (r.type === "commitment" || ADULT_WORDS.test(r.label) || ADULT_WORDS.test(String(r.kind ?? ""))),
      ownerId: r.ownerId, sourceId: src?.sourceId ?? null, quote: src?.quote ?? null,
    });
  }
  return world;
}

/* ── Commitments for fulfilment and contradictions ───────────────────────────────────────────────────── */

export type Party = { id: string; label: string; aliases: string[]; emails: string[] };

/** The other parties' names, aliases and addresses. */
export async function partiesOf(v: Viewer, ids: string[]): Promise<Map<string, Party>> {
  if (!ids.length) return new Map();
  const ctx = await accessContext(v);
  const rows = await db.select({ id: nodes.id, label: nodes.label, aliases: nodes.aliases, props: nodes.props }).from(nodes)
    .where(and(inArray(nodes.id, [...new Set(ids)]), nodeReadSql(ctx, "nodes")));
  return new Map(rows.map((r) => [r.id, {
    id: r.id, label: r.label, aliases: r.aliases ?? [],
    emails: [...list(r.props?.email), ...list(r.props?.emails), ...list(r.props?.work_email)].map((e) => e.toLowerCase()).filter((e) => e.includes("@")),
  }]));
}

/**
 * The other parties of each commitment, widened by what its own documents name: organisations the documents it arises
 * from are linked to (the landlord company a lease names when detection only recorded "udlejer"), and email addresses
 * written in its own sources. `wide: false` gives the recorded counterparty only (falling back to the wide set when
 * none is recorded).
 */
export async function partiesFor(v: Viewer, items: CommitmentView[], own: Map<string, { ids: string[] }>, opts: { wide: boolean }): Promise<Map<string, Party[]>> {
  const ctx = await accessContext(v);
  const direct = await partiesOf(v, items.flatMap((c) => c.counterparty.map((p) => p.id)));
  const docIds = [...new Set(items.flatMap((c) => c.arisesFrom.map((p) => p.id)))];
  const docEdges = docIds.length ? await db.select({ fromId: edges.fromId, toId: edges.toId }).from(edges).where(and(
    eq(edges.graphId, v.graphId), notInArray(edges.status, [...DEAD]), edgeSelfReadSql(ctx, "edges"),
    or(inArray(edges.fromId, docIds), inArray(edges.toId, docIds)),
  )).limit(400) : [];
  const near = [...new Set(docEdges.flatMap((e) => [e.fromId, e.toId]).filter((id) => !docIds.includes(id)))];
  const orgs = near.length ? new Map((await db.select({ id: nodes.id, label: nodes.label, aliases: nodes.aliases, props: nodes.props }).from(nodes)
    .where(and(inArray(nodes.id, near), eq(nodes.type, "organization"), isNull(nodes.mergedInto), nodeReadSql(ctx, "nodes"))))
    .map((r) => [r.id, { id: r.id, label: r.label, aliases: r.aliases ?? [], emails: [...list(r.props?.email), ...list(r.props?.emails)].map((e) => e.toLowerCase()) } as Party])) : new Map<string, Party>();
  const allOwn = [...new Set([...own.values()].flatMap((o) => o.ids))];
  const texts = allOwn.length ? await db.select({ id: sources.id, text: sources.textContent }).from(sources).where(and(inArray(sources.id, allOwn), sourceVisibleTo(v))) : [];
  const emailsIn = new Map(texts.map((t) => [t.id, [...new Set((t.text ?? "").slice(0, 20_000).toLowerCase().match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g) ?? [])]]));
  const out = new Map<string, Party[]>();
  for (const c of items) {
    const recorded = c.counterparty.map((p) => direct.get(p.id)).filter((p): p is Party => !!p);
    const docs = new Set(c.arisesFrom.map((p) => p.id));
    const widened: Party[] = [];
    for (const e of docEdges) {
      const other = docs.has(e.fromId) ? e.toId : docs.has(e.toId) ? e.fromId : null;
      const o = other ? orgs.get(other) : undefined;
      if (o && !widened.some((w) => w.id === o.id) && !recorded.some((r) => r.id === o.id)) widened.push(o);
    }
    const mails = (own.get(c.id)?.ids ?? []).flatMap((id) => emailsIn.get(id) ?? []);
    if (mails.length) widened.push({ id: `emails:${c.id}`, label: "", aliases: [], emails: [...new Set(mails)] });
    out.set(c.id, opts.wide || !recorded.length ? [...recorded, ...widened] : recorded);
  }
  return out;
}

/** Sources behind each commitment: the ones it was read from, and the sources of the documents it arises from. */
export async function ownSourcesOf(v: Viewer, list: CommitmentView[]): Promise<Map<string, { ids: string[]; threadKeys: string[]; firstAt: Date | null }>> {
  const docNodes = [...new Set(list.flatMap((c) => c.arisesFrom.map((p) => p.id)))];
  const byDoc = docNodes.length ? await db.select({ id: sources.id, nodeId: sources.nodeId }).from(sources)
    .where(and(eq(sources.graphId, v.graphId), inArray(sources.nodeId, docNodes), sourceVisibleTo(v))) : [];
  const all = [...new Set([...list.flatMap((c) => c.sources.map((s) => s.sourceId)), ...byDoc.map((s) => s.id)])];
  const meta = all.length ? await db.select({ id: sources.id, threadKey: sources.threadKey, at: sql<Date>`coalesce(${sources.documentDate}, ${sources.createdAt})` }).from(sources)
    .where(and(inArray(sources.id, all), sourceVisibleTo(v))) : [];
  const info = new Map(meta.map((m) => [m.id, m]));
  const out = new Map<string, { ids: string[]; threadKeys: string[]; firstAt: Date | null }>();
  for (const c of list) {
    const docIds = new Set(c.arisesFrom.map((p) => p.id));
    const mine = [...new Set([...c.sources.map((s) => s.sourceId), ...byDoc.filter((s) => s.nodeId && docIds.has(s.nodeId)).map((s) => s.id)])].filter((id) => info.has(id));
    const dates = mine.map((id) => new Date(info.get(id)!.at)).filter((d) => !Number.isNaN(d.getTime()));
    out.set(c.id, {
      ids: mine,
      threadKeys: [...new Set(mine.map((id) => info.get(id)!.threadKey).filter((k): k is string => !!k))],
      firstAt: dates.length ? new Date(Math.min(...dates.map((d) => d.getTime()))) : null,
    });
  }
  return out;
}

/** The commitments in the shape the fulfilment check reads. */
export async function fulfilShapes(v: Viewer, list: CommitmentView[]): Promise<FulfilCommitment[]> {
  const own = await ownSourcesOf(v, list);
  const parties = await partiesFor(v, list, own, { wide: false });
  return list.map((c) => {
    const ps = parties.get(c.id) ?? [];
    const o = own.get(c.id);
    const created = new Date(c.createdAt);
    const appearedAt = o?.firstAt && o.firstAt < created ? o.firstAt : created;
    return {
      id: c.id, label: c.label, kind: c.props.kind, direction: c.props.direction, dueAt: c.props.dueAt ? new Date(c.props.dueAt) : null, appearedAt,
      amount: c.props.amount ?? null,
      counterparty: { names: [...new Set(ps.flatMap((p) => [p.label, ...p.aliases]).filter(Boolean))], emails: [...new Set(ps.flatMap((p) => p.emails))] },
      threadKeys: o?.threadKeys ?? [], ownSourceIds: o?.ids ?? [], recurring: c.props.dueKind === "recurring" || !!c.props.recurrence,
    };
  });
}

/** Addresses that are the person's own (their account, and the email on their own node in this graph). */
export async function ownAddresses(userId: string, graphId: string): Promise<Set<string>> {
  const out = new Set<string>();
  const [u] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
  if (u?.email) out.add(u.email.toLowerCase());
  const self = (await memberSelfNodes(graphId)).get(userId);
  if (self) {
    const [n] = await db.select({ props: nodes.props }).from(nodes).where(eq(nodes.id, self)).limit(1);
    for (const e of [...list(n?.props?.email), ...list(n?.props?.emails), ...list(n?.props?.work_email)]) out.add(e.toLowerCase());
  }
  return out;
}

type SourceRow = { id: string; title: string; kind: string; mime: string | null; meta: Record<string, unknown>; textContent: string | null; threadKey: string | null; nodeId: string | null; at: Date; sensitive: boolean };

const sourceCols = {
  id: sources.id, title: sources.title, kind: sources.kind, mime: sources.mime, meta: sources.meta, textContent: sources.textContent,
  threadKey: sources.threadKey, nodeId: sources.nodeId, at: sql<Date>`coalesce(${sources.documentDate}, ${sources.createdAt})`, sensitive: sources.sensitive,
};

/** One source as the viewer may open it (ready only), or null. */
export async function readableSource(v: Viewer, sourceId: string): Promise<SourceRow | null> {
  const [s] = await db.select(sourceCols).from(sources).where(and(eq(sources.id, sourceId), eq(sources.status, "ready"), sourceVisibleTo(v))).limit(1);
  return s ? { ...s, at: new Date(s.at) } : null;
}

/** Ready sources added since `since`, newest first (the safety net and new commitments looking back). */
export async function recentSources(v: Viewer, since: Date, limit = 60): Promise<SourceRow[]> {
  const rows = await db.select(sourceCols).from(sources)
    .where(and(eq(sources.graphId, v.graphId), eq(sources.status, "ready"), gte(sources.createdAt, since), isNull(sources.supersededAt), sourceVisibleTo(v)))
    .orderBy(desc(sources.createdAt)).limit(limit);
  return rows.map((s) => ({ ...s, at: new Date(s.at) }));
}

export function evidenceOf(s: SourceRow, own: Set<string>): Evidence {
  const email = (s.meta?.email ?? {}) as { participants?: unknown; from?: unknown };
  const participants = Array.isArray(email.participants)
    ? (email.participants as { email?: unknown; name?: unknown; role?: unknown }[]).filter((p) => typeof p?.email === "string")
      .map((p) => ({ email: String(p.email).toLowerCase(), name: typeof p.name === "string" ? p.name : null, role: typeof p.role === "string" ? p.role : null }))
    : [];
  const from = participants.find((p) => p.role === "from");
  const sentFolder = /sent|sendt|afsendt/i.test(String((s.meta as Record<string, unknown>)?.folder ?? (s.meta as Record<string, unknown>)?.mailbox ?? ""));
  return {
    sourceId: s.id, title: s.title, text: (s.textContent ?? "").slice(0, 30_000), date: s.at,
    authoredByOwner: (!!from && own.has(from.email)) || sentFolder, participants, threadKey: s.threadKey,
  };
}

/* ── Statements for contradictions ───────────────────────────────────────────────────────────────────── */

/**
 * What each commitment's sources say, plus related ones: the same thread, documents linked to the other party, and
 * documents naming the other party (newest first, a handful). Approved rules come from `rulesFor`.
 */
export async function statementsFor(v: Viewer, c: CommitmentView, own: { ids: string[]; threadKeys: string[] }, party: Party[]): Promise<Statement[]> {
  const ctx = await accessContext(v);
  const rel = new Map<string, NonNullable<Statement["rel"]>>(own.ids.map((id) => [id, "own"]));
  const add = (id: string, r: NonNullable<Statement["rel"]>) => { if (!rel.has(id)) rel.set(id, r); };
  if (own.threadKeys.length) {
    const t = await db.select({ id: sources.id }).from(sources)
      .where(and(eq(sources.graphId, v.graphId), inArray(sources.threadKey, own.threadKeys), sourceVisibleTo(v))).limit(10);
    t.forEach((r) => add(r.id, "thread"));
  }
  const partyIds = party.map((p) => p.id).filter((id) => UUID.test(id));
  if (partyIds.length) {
    const linked = await db.select({ id: sources.id }).from(sources)
      .innerJoin(edges, or(and(eq(edges.fromId, sources.nodeId), inArray(edges.toId, partyIds)), and(eq(edges.toId, sources.nodeId), inArray(edges.fromId, partyIds))))
      .where(and(eq(sources.graphId, v.graphId), eq(edges.graphId, v.graphId), notInArray(edges.status, [...DEAD]), edgeSelfReadSql(ctx, "edges"), sourceVisibleTo(v), isNull(sources.supersededAt)))
      .orderBy(desc(sources.createdAt)).limit(8);
    linked.forEach((r) => add(r.id, "party"));
  }
  const names = [...new Set(party.flatMap((p) => [p.label, ...p.aliases]).flatMap(nameVariants))].filter((n) => n.trim().length >= 4).slice(0, 6);
  const emails = [...new Set(party.flatMap((p) => p.emails))].slice(0, 6);
  if (names.length || emails.length) {
    const named = await db.select({ id: sources.id }).from(sources)
      .where(and(eq(sources.graphId, v.graphId), eq(sources.status, "ready"), isNull(sources.supersededAt), sourceVisibleTo(v),
        gte(sources.createdAt, new Date(Date.now() - 3 * 365 * DAY)),
        or(...names.map((n) => sql`${sources.textContent} ilike ${`%${n.replace(/[%_\\]/g, "")}%`}`),
          ...emails.map((e) => sql`(${sources.textContent} ilike ${`%${e.replace(/[%_\\]/g, "")}%`} or ${sources.meta}::text ilike ${`%${e.replace(/[%_\\]/g, "")}%`})`))))
      .orderBy(desc(sources.createdAt)).limit(8);
    named.forEach((r) => add(r.id, "party"));
  }
  if (!rel.size) return [];
  const rows = await db.select(sourceCols).from(sources).where(and(inArray(sources.id, [...rel.keys()]), sourceVisibleTo(v), ne(sources.status, "failed"))).limit(16);
  return rows.filter((s) => s.textContent).map((s) => ({
    sourceId: s.id, title: s.title, cls: classifySource(s), date: new Date(s.at), text: s.textContent!.slice(0, 40_000), rel: rel.get(s.id),
  }));
}

/** Approved rules (active corpus rules of this graph) that speak about the same thing as the commitment. */
export async function rulesFor(v: Viewer, c: CommitmentView, statements: Statement[]): Promise<Statement[]> {
  if (!["notice", "reply", "form", "renewal"].includes(c.props.kind)) return [];
  const rows = await db.select({ id: corpusRules.id, ref: corpusRules.ref, title: corpusRules.title, text: corpusRules.text, quote: corpusRules.quote, sourceId: corpusRules.sourceId })
    .from(corpusRules)
    .where(and(eq(corpusRules.graphId, v.graphId), eq(corpusRules.status, "active"), eq(corpusRules.kind, "rule"),
      sql`(${corpusRules.text} ~* '(dage|uger|måned|days|weeks|months)' or coalesce(${corpusRules.quote}, '') ~* '(dage|uger|måned|days|weeks|months)')`))
    .limit(400);
  if (!rows.length) return [];
  // Relevant: the commitment's own words (label, summary, its sources' text) share at least two telling words with the rule.
  const words = (s: string) => new Set(s.toLowerCase().split(/[^\p{L}]+/u).filter((w) => w.length >= 6));
  const mine = words(`${c.label} ${c.summary ?? ""} ${statements.filter((s) => c.sources.some((x) => x.sourceId === s.sourceId)).map((s) => s.text.slice(0, 4000)).join(" ")}`);
  return rows.filter((r) => {
    const w = words(`${r.title} ${r.text}`);
    return [...w].filter((x) => mine.has(x)).length >= 2 || mine.has(r.ref.toLowerCase());
  }).slice(0, 4).map((r) => ({
    sourceId: r.sourceId ?? `rule:${r.id}`, ruleId: r.id, ruleRef: r.ref, title: r.title, cls: "rule" as const, date: null, text: `${r.text}\n${r.quote ?? ""}`,
  }));
}

/* ── Progress signals ────────────────────────────────────────────────────────────────────────────────── */

/** The newest source per commitment after it appeared that is about it: same thread, or naming / addressing the other party. */
export async function latestRelatedSource(v: Viewer, c: CommitmentView, own: { ids: string[]; threadKeys: string[] }, party: Party[], after: Date): Promise<{ id: string; title: string; at: Date } | null> {
  const names = [...new Set(party.flatMap((p) => [p.label, ...p.aliases]).flatMap(nameVariants))].filter((n) => n.trim().length >= 4).slice(0, 6);
  const emails = [...new Set(party.flatMap((p) => p.emails))].slice(0, 6);
  const conds = [
    own.threadKeys.length ? inArray(sources.threadKey, own.threadKeys) : undefined,
    ...names.map((n) => sql`${sources.textContent} ilike ${`%${n.replace(/[%_\\]/g, "")}%`}`),
    ...emails.map((e) => sql`${sources.meta}::text ilike ${`%${e.replace(/[%_\\]/g, "")}%`}`),
  ].filter(Boolean);
  if (!conds.length) return null;
  const [row] = await db.select({ id: sources.id, title: sources.title, at: sources.createdAt }).from(sources)
    .where(and(eq(sources.graphId, v.graphId), ne(sources.status, "failed"), gte(sources.createdAt, after), sourceVisibleTo(v),
      own.ids.length ? sql`${sources.id} not in (${ids(own.ids)})` : undefined, or(...conds)))
    .orderBy(desc(sources.createdAt)).limit(1);
  return row ?? null;
}
