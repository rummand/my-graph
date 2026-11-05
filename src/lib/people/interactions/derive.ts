/**
 * Deriving interactions (server). Nothing here is typed in: it reads what the graph already holds after a person
 * delivered it, and records one row per (person, carrier) in person_interactions. Idempotent (on conflict do nothing),
 * so running it again — after a delivery, or as the backfill — never doubles anything.
 *
 *   email      a person is a sender or recipient of an email source (meta.email.participants)
 *   message    a person wrote in a chat export (WhatsApp, Messenger, iMessage), one per day
 *   call       a call with a person in the Mac's call history, one per day
 *   meeting    an event they took part in that is a meeting (a recording, kind meeting/session/consultation)
 *   event      any other past event they took part in (involves)
 *   photo      a photo whose document names them
 *   mention    any other document or page that names them
 *   edit       a member of the graph changing it themselves, one per day
 *
 * Only real people count: live person nodes in the source's graph (not merged, not retired). Each row keeps who the
 * carrier belongs to (`ownerId`) and its visibility; reads (read.ts) re-check the carrier for the viewer.
 */
import { and, eq, gte, inArray, isNull, lte, notInArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { chunks, edges, graphEvents, graphs, nodes, personInteractions, sources } from "@/db/schema";
import { liveNodeSql } from "@/lib/gbrain/access";
import { memberSelfNodes } from "@/lib/graphs/self";
import { KIND_INFO, linesOf, matchRef, type InteractionKind, type PersonRef } from "./pure";

type Row = typeof personInteractions.$inferInsert;
const DEAD = ["rejected", "superseded"] as const;
const MEETING_KINDS = new Set(["meeting", "session", "consultation", "appointment"]);
const CHAT_IMPORTERS = new Set(["whatsapp", "messenger", "imessage"]);

const str = (x: unknown) => (typeof x === "string" ? x : null);
const list = (x: unknown): string[] => (Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : typeof x === "string" ? [x] : []);

async function peopleOf(graphId: string): Promise<PersonRef[]> {
  const rows = await db.select({ id: nodes.id, label: nodes.label, aliases: nodes.aliases, props: nodes.props }).from(nodes)
    .where(and(eq(nodes.graphId, graphId), eq(nodes.type, "person"), isNull(nodes.mergedInto), liveNodeSql("nodes")));
  return rows.map((r) => ({
    id: r.id, label: r.label, aliases: r.aliases ?? [],
    emails: [...list(r.props?.email), ...list(r.props?.emails), ...list(r.props?.work_email)],
    phones: [...list(r.props?.phone), ...list(r.props?.phones)],
  }));
}

function row(base: { graphId: string; householdId: string; ownerId: string; visibility: Row["visibility"]; sensitive: boolean },
  nodeId: string, kind: InteractionKind, at: Date, dedupeKey: string, extra: Partial<Row> = {}): Row {
  const info = KIND_INFO[kind];
  return { ...base, nodeId, kind, strength: info.strength, weight: info.weight, at, dedupeKey, ...extra };
}

async function save(rows: Row[]): Promise<number> {
  if (!rows.length) return 0;
  let n = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const r = await db.insert(personInteractions).values(rows.slice(i, i + 500)).onConflictDoNothing().returning({ id: personInteractions.id });
    n += r.length;
  }
  return n;
}

const dayAt = (day: string, time: string | null) => {
  const d = new Date(`${day}T${time && /^\d{1,2}:\d{2}$/.test(time) ? time.padStart(5, "0") : "12:00"}:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** Everything one source says about who the viewer was in touch with. */
export async function deriveForSource(sourceId: string, people?: PersonRef[]): Promise<number> {
  const [src] = await db.select().from(sources).where(eq(sources.id, sourceId));
  if (!src || src.status === "failed") return 0;
  const refs = people ?? await peopleOf(src.graphId);
  if (!refs.length) return 0;
  const selfIds = new Set([...(await memberSelfNodes(src.graphId)).entries()].filter(([u]) => u === src.ownerId).map(([, n]) => n));
  const base = { graphId: src.graphId, householdId: src.householdId, ownerId: src.ownerId, visibility: src.visibility, sensitive: src.sensitive };
  const meta = (src.meta ?? {}) as Record<string, unknown>;
  const at = src.documentDate ?? src.createdAt;
  const title = src.title.slice(0, 120);
  const out: Row[] = [];
  const direct = new Set<string>();
  const push = (nodeId: string, kind: InteractionKind, when: Date, key: string) => {
    if (selfIds.has(nodeId)) return;
    direct.add(nodeId);
    out.push(row(base, nodeId, kind, when, key, { sourceId: src.id, detail: title }));
  };

  // Email: senders and recipients.
  const email = meta.email as { participants?: { email?: string; name?: string | null }[]; from?: string | null } | undefined;
  for (const p of email?.participants ?? []) {
    const hit = matchRef(refs, { email: p.email ?? null, name: p.name ?? null });
    if (hit) push(hit.id, "email", at, `source:${src.id}`);
  }

  // Chats and calls: who wrote or called, per day.
  const importer = str(meta.importer);
  if (importer && (CHAT_IMPORTERS.has(importer) || importer === "calls")) {
    const texts = await db.select({ text: chunks.text }).from(chunks).where(eq(chunks.sourceId, src.id)).orderBy(chunks.idx);
    const mode = importer === "calls" ? "calls" : "chat";
    for (const c of texts) for (const h of linesOf(c.text, mode)) {
      const hit = matchRef(refs, { name: h.name, phone: h.phone });
      const when = dayAt(h.day, h.time);
      if (hit && when) push(hit.id, mode === "calls" ? "call" : "message", when, `source:${src.id}:${h.day}`);
    }
  }

  // Everyone else the document names: a photo with them, a meeting's recording, or a mention.
  if (src.nodeId) {
    const named = await db.select({ toId: edges.toId }).from(edges).innerJoin(nodes, eq(nodes.id, edges.toId))
      .where(and(eq(edges.fromId, src.nodeId), inArray(edges.relation, ["mentions", "about", "depicts"]), notInArray(edges.status, [...DEAD]),
        eq(nodes.type, "person"), isNull(nodes.mergedInto), liveNodeSql("nodes")));
    const photo = (src.mime ?? "").startsWith("image/") || meta.docKind === "photo";
    const kind: InteractionKind = photo ? "photo" : src.kind === "recording" ? "meeting" : "mention";
    for (const { toId } of named) {
      if (direct.has(toId) || selfIds.has(toId)) continue;
      out.push(row(base, toId, kind, at, `source:${src.id}`, { sourceId: src.id, detail: title }));
    }
  }
  // Same person and carrier twice in one pass (a long chat on one day): keep the latest moment.
  const byKey = new Map<string, Row>();
  for (const r of out) { const k = `${r.nodeId}|${r.dedupeKey}`; const prev = byKey.get(k); if (!prev || r.at > prev.at) byKey.set(k, r); }
  return save([...byKey.values()]);
}

/** Past events people took part in (event —involves→ person). `eventIds` limits it to some events. */
export async function deriveForEvents(graphId: string, eventIds?: string[], now = new Date()): Promise<number> {
  if (eventIds && !eventIds.length) return 0;
  const rows = await db.select({
    eventId: nodes.id, label: nodes.label, kind: nodes.kind, startAt: nodes.startAt, ownerId: nodes.ownerId, householdId: nodes.householdId,
    visibility: nodes.visibility, sensitive: nodes.sensitive, personId: edges.toId,
  }).from(edges).innerJoin(nodes, eq(nodes.id, edges.fromId))
    .where(and(eq(edges.graphId, graphId), eq(edges.relation, "involves"), notInArray(edges.status, [...DEAD]), eq(nodes.type, "event"),
      isNull(nodes.mergedInto), liveNodeSql("nodes"), lte(nodes.startAt, now), eventIds ? inArray(nodes.id, eventIds) : undefined));
  if (!rows.length) return 0;
  const live = new Set((await db.select({ id: nodes.id }).from(nodes).where(and(inArray(nodes.id, [...new Set(rows.map((r) => r.personId))]),
    eq(nodes.type, "person"), isNull(nodes.mergedInto), liveNodeSql("nodes")))).map((r) => r.id));
  const out: Row[] = rows.filter((r) => live.has(r.personId) && r.startAt).map((r) => row(
    { graphId, householdId: r.householdId, ownerId: r.ownerId, visibility: r.visibility, sensitive: r.sensitive },
    r.personId, MEETING_KINDS.has(r.kind ?? "") ? "meeting" : "event", r.startAt!, `node:${r.eventId}`, { subjectId: r.eventId, detail: r.label.slice(0, 120) },
  ));
  return save(out);
}

/** Members changing the graph themselves (one row per member per day). */
export async function deriveEdits(graphId: string, since?: Date): Promise<number> {
  const selves = await memberSelfNodes(graphId);
  if (!selves.size) return 0;
  const [g] = await db.select({ householdId: graphs.householdId }).from(graphs).where(eq(graphs.id, graphId));
  if (!g) return 0;
  const days = await db.select({
    actorId: graphEvents.actorId, day: sql<string>`to_char(${graphEvents.at} at time zone 'UTC', 'YYYY-MM-DD')`, at: sql<Date>`max(${graphEvents.at})`.mapWith((x: string | Date) => new Date(x)),
  }).from(graphEvents).where(and(eq(graphEvents.graphId, graphId), eq(graphEvents.actorKind, "person"), inArray(graphEvents.actorId, [...selves.keys()]),
    since ? gte(graphEvents.at, since) : undefined))
    .groupBy(graphEvents.actorId, sql`2`);
  const out: Row[] = [];
  for (const d of days) {
    const nodeId = d.actorId ? selves.get(d.actorId) : undefined;
    if (!nodeId || !d.actorId) continue;
    out.push(row({ graphId, householdId: g.householdId, ownerId: d.actorId, visibility: "household", sensitive: false }, nodeId, "edit", d.at, `edit:${d.day}`));
  }
  return save(out);
}

/**
 * After a change set was delivered (best effort, outside its transaction): the source it came from, the events it
 * added or connected, and the person's own edit today.
 */
export async function deriveAfterDelivery(graphId: string, input: { sourceId?: string | null; nodeIds?: string[]; edgeIds?: string[] }): Promise<number> {
  let n = 0;
  if (input.sourceId) n += await deriveForSource(input.sourceId);
  const eventIds = new Set<string>();
  if (input.nodeIds?.length) {
    for (const r of await db.select({ id: nodes.id }).from(nodes).where(and(inArray(nodes.id, input.nodeIds), eq(nodes.type, "event")))) eventIds.add(r.id);
  }
  if (input.edgeIds?.length) {
    for (const r of await db.select({ fromId: edges.fromId }).from(edges).where(and(inArray(edges.id, input.edgeIds), eq(edges.relation, "involves")))) eventIds.add(r.fromId);
  }
  if (eventIds.size) n += await deriveForEvents(graphId, [...eventIds]);
  n += await deriveEdits(graphId, new Date(Date.now() - 2 * 86_400_000));
  return n;
}

/** Everything already in a graph (or every graph). Safe to run again. */
export async function backfillInteractions(graphId?: string): Promise<Record<string, { sources: number; events: number; edits: number }>> {
  const gs = graphId ? [{ id: graphId }] : await db.select({ id: graphs.id }).from(graphs);
  const out: Record<string, { sources: number; events: number; edits: number }> = {};
  for (const g of gs) {
    const people = await peopleOf(g.id);
    let s = 0;
    if (people.length) {
      const srcs = await db.select({ id: sources.id }).from(sources).where(and(eq(sources.graphId, g.id), eq(sources.status, "ready")));
      for (const x of srcs) s += await deriveForSource(x.id, people);
    }
    out[g.id] = { sources: s, events: await deriveForEvents(g.id), edits: await deriveEdits(g.id) };
  }
  return out;
}
