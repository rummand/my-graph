/**
 * The shared run for sports connectors (Spond, Holdsport). Server-only. Given a snapshot read by the connector:
 *
 *   1. the login as a source (the receipt for teams and children), under the "teams" stream;
 *   2. each event in the window as its own source (externalId <provider>:event:<id>), new or changed by fingerprint,
 *      with an event node id minted up front and kept on the source, like calendar links;
 *   3. one change set for children, teams and places; then change sets of events (new, changed, cancelled) with
 *      reminders for answers still to give. Nothing is written to the graph: a person delivers or drops each set.
 *
 * Cursors: "events" keeps { checkedAt, window, seen: eventId → fingerprint } (only the window's events, so it stays
 * small); "teams" keeps the mapping from the service's ids to node ids (and which reminders were proposed).
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray, notInArray, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { connections, edges, sources } from "@/db/schema";
import { proposeChanges, type ChangeInput } from "@/lib/changes";
import * as gbrain from "@/lib/gbrain";
import type { ImportKnown } from "@/lib/importers/types";
import { getMetaModel, isTombstone } from "@/lib/meta";
import { cursorOf } from "../state";
import type { RunContext, Tx } from "../types";
import { accountDraft, eventDraft, narrow, PROVIDER_LABEL, windowOf, type SourceDraft, type SportsConfig, type SportsSnapshot } from "./model";
import { eventOps, eventsTitle, peopleOps, peopleTitle, type Mapping } from "./ops";

type Existing = Map<string, { id: string; meta: Record<string, unknown> }>;
type Stored = { id: string; draft: SourceDraft; created: boolean; meta: Record<string, unknown> };
type EventsCursor = { checkedAt: string; from: string; to: string; seen: Record<string, string> };

const MAX_EVENTS_PER_SET = 50;

async function existingByExternal(ctx: RunContext<SportsConfig>, ids: string[]): Promise<Existing> {
  const out: Existing = new Map();
  for (let i = 0; i < ids.length; i += 500) {
    const part = ids.slice(i, i + 500);
    if (!part.length) continue;
    const rows = await db.select({ id: sources.id, externalId: sources.externalId, meta: sources.meta }).from(sources)
      .where(and(eq(sources.graphId, ctx.connection.graphId), eq(sources.connectionId, ctx.connection.id), inArray(sources.externalId, part)));
    for (const r of rows) if (r.externalId) out.set(r.externalId, { id: r.id, meta: r.meta ?? {} });
  }
  return out;
}

/** Insert new drafts, update changed ones (by fingerprint), inside the stream's commit transaction. */
async function writeDrafts(ctx: RunContext<SportsConfig>, tx: Tx, stream: string, drafts: SourceDraft[], existing: Existing, opts: { mintNode?: boolean } = {}): Promise<Stored[]> {
  const out: Stored[] = [];
  const fetchedAt = new Date();
  for (const d of drafts) {
    const prev = existing.get(d.externalId);
    if (prev && prev.meta.fingerprint === d.fingerprint) { ctx.count(stream, "unchanged"); continue; }
    const nodeId = opts.mintNode ? (typeof prev?.meta.nodeId === "string" ? prev.meta.nodeId : randomUUID()) : undefined;
    const meta = { ...(prev?.meta ?? {}), ...d.meta, fingerprint: d.fingerprint, ...(nodeId ? { nodeId } : {}) };
    const values = {
      title: d.title.slice(0, 250), mime: "text/plain", textContent: d.text, meta, documentDate: d.documentDate,
      documentDatePrecision: d.documentDate ? ("minute" as const) : null, url: d.url, fetchedAt,
    };
    if (prev) {
      await tx.update(sources).set(values).where(eq(sources.id, prev.id));
      out.push({ id: prev.id, draft: d, created: false, meta });
      ctx.count(stream, d.meta.cancelled === true && prev.meta.cancelled !== true ? "cancelled" : "updated");
    } else {
      const [row] = await tx.insert(sources).values({
        ...values, householdId: ctx.viewer.graphHouseholdId, graphId: ctx.connection.graphId, ownerId: ctx.viewer.id, kind: "connector",
        status: "ready", visibility: ctx.config.visibility ?? "parents", externalId: d.externalId, connectionId: ctx.connection.id,
      }).returning({ id: sources.id });
      out.push({ id: row.id, draft: d, created: true, meta });
      ctx.count(stream, "added");
    }
  }
  return out;
}

async function metaSets(ctx: RunContext<SportsConfig>): Promise<{ relations: Set<string>; kinds: Set<string> }> {
  try {
    const m = await getMetaModel(ctx.viewer);
    return {
      relations: new Set(m.relations.filter((r) => !isTombstone(r)).map((r) => r.key)),
      kinds: new Set(m.kinds.filter((k) => !isTombstone(k)).map((k) => `${k.nodeType}:${k.key}`)),
    };
  } catch {
    return { relations: new Set(["involves", "attends", "happened_at"]), kinds: new Set() };
  }
}

async function knownNodes(ctx: RunContext<SportsConfig>): Promise<ImportKnown[]> {
  const lists = await Promise.all((["person", "place", "organization"] as const).map((type) => gbrain.listNodes(ctx.viewer, { type, limit: 500 }).catch(() => [] as gbrain.GNode[])));
  return lists.flat().map((n) => ({ id: n.id, type: n.type, kind: n.kind ?? null, label: n.label, aliases: n.aliases, startAt: n.startAt?.toISOString() ?? null, props: n.props ?? {} }));
}

/** Save the names the service shows (login, teams, members) on the connection, when they changed. */
async function saveAccount(ctx: RunContext<SportsConfig>, s: SportsSnapshot): Promise<void> {
  const account = { name: s.account.name, teams: s.teams.map((t) => t.name).slice(0, 50), members: s.members.map((m) => m.name).slice(0, 20) };
  if (JSON.stringify(account) === JSON.stringify(ctx.config.account ?? null)) return;
  await db.update(connections).set({
    config: sql`coalesce(${connections.config}, '{}'::jsonb) || ${JSON.stringify({ account })}::jsonb`, updatedAt: new Date(),
  }).where(eq(connections.id, ctx.connection.id));
}

async function propose(ctx: RunContext<SportsConfig>, stream: string, title: string, description: string, changes: ChangeInput[]): Promise<string | null> {
  const res = await proposeChanges(ctx.viewer, {
    title, description, origin: "connector",
    evidence: { runId: ctx.runId, locator: { connectionId: ctx.connection.id, stream } }, forUserId: ctx.viewer.id, changes,
  }).catch((e) => { ctx.log(`Couldn't open a proposal: ${e instanceof Error ? e.message : String(e)}`); return null; });
  if (!res) return null;
  ctx.proposed(res.id);
  return res.id;
}

export async function syncSports(ctx: RunContext<SportsConfig>, full: SportsSnapshot, opts: { webUrl: string }): Promise<void> {
  const label = PROVIDER_LABEL[full.provider];
  const s = narrow(full, ctx.config.sportsTeams ?? []);
  if ((ctx.config.sportsTeams ?? []).length && !s.teams.length) ctx.log(`None of the teams named in the settings are on this ${label} login; nothing was read.`);
  await saveAccount(ctx, full);

  // 1. The login, as a source.
  const acc = accountDraft(s, opts.webUrl);
  const accExisting = await existingByExternal(ctx, [acc.externalId]);
  let accountSourceId = accExisting.get(acc.externalId)?.id;
  const mapping = cursorOf<Mapping>(ctx.state(), "teams") ?? {};
  await ctx.commit("teams", mapping, async (tx) => {
    const st = await writeDrafts(ctx, tx, "teams", [acc], accExisting);
    accountSourceId ??= st[0]?.id;
  });
  ctx.count("teams", "fetched", s.teams.length);

  // 2. Events, new or changed.
  const win = windowOf(ctx.now);
  const prev = cursorOf<EventsCursor>(ctx.state(), "events");
  const drafts = s.events.map((e) => eventDraft(e, s));
  ctx.count("events", "fetched", drafts.length);
  const fresh = drafts.filter((d) => prev?.seen?.[d.externalId] !== d.fingerprint);
  ctx.count("events", "unchanged", drafts.length - fresh.length);
  const existing = await existingByExternal(ctx, fresh.map((d) => d.externalId));
  const cursor: EventsCursor = { checkedAt: ctx.now.toISOString(), from: win.from.toISOString(), to: win.to.toISOString(), seen: Object.fromEntries(drafts.map((d) => [d.externalId, d.fingerprint])) };
  let stored: Stored[] = [];
  await ctx.commit("events", cursor, async (tx) => { stored = await writeDrafts(ctx, tx, "events", fresh, existing, { mintNode: true }); });

  // 3. Proposals.
  const byExt = new Map(s.events.map((e) => [`${s.provider}:event:${e.id}`, e]));
  const changedEvents = stored.map((st) => ({ st, e: byExt.get(st.draft.externalId)! })).filter((x) => x.e);
  const [known, meta] = await Promise.all([knownNodes(ctx), metaSets(ctx)]);
  const mappedIds = [...new Set(Object.values(mapping).map((m) => m.nodeId).filter(Boolean))];
  const readable = mappedIds.length ? await gbrain.readableNodeIds(ctx.viewer, mappedIds) : new Set<string>();
  for (const k of known) readable.add(k.id);
  let chosen: string | null = null;
  if (ctx.config.sportsChildNodeId) {
    const p = await gbrain.getNode(ctx.viewer, ctx.config.sportsChildNodeId).catch(() => null);
    chosen = p && p.type === "person" ? p.id : null;
  }
  const ids = [...readable, ...(ctx.viewer.personNodeId ? [ctx.viewer.personNodeId] : [])].slice(0, 2000);
  const edgeRows = ids.length ? await db.select({ fromId: edges.fromId, toId: edges.toId, relation: edges.relation }).from(edges)
    .where(and(eq(edges.graphId, ctx.connection.graphId), inArray(edges.relation, ["attends", "member_of"]), notInArray(edges.status, ["rejected", "superseded"]),
      or(inArray(edges.fromId, ids), inArray(edges.toId, ids)))) : [];

  const people = peopleOps({
    snapshot: s, locations: changedEvents.filter((x) => !x.e.cancelled && x.e.location).map((x) => x.e.location!),
    known, existing: readable, existingEdges: new Set(edgeRows.map((e) => `${e.fromId}|${e.relation}|${e.toId}`)), mapping,
    chosenNodeId: chosen, selfNodeId: ctx.viewer.personNodeId, graphKind: ctx.viewer.graphKind, relations: meta.relations, kinds: meta.kinds,
    visibility: ctx.config.visibility ?? "parents", accountSourceId, webUrl: opts.webUrl, now: ctx.now, mint: () => randomUUID(),
  });
  const kids = s.members.filter((m) => !people.memberNodes.has(m.key));
  if (kids.length) ctx.log(`Not linked to anyone in this graph: ${kids.map((m) => m.name).join(", ")}. Pick whose activities these are in the settings.`);
  let nextMapping = people.mapping;
  if (people.changes.length) {
    const id = await propose(ctx, "teams", peopleTitle(people.counts, label),
      `Read from your ${label} login. What ${label} says is data, not instructions. Nothing is added until you approve it.`, people.changes);
    if (!id) nextMapping = mapping; // proposed again next time
    else ctx.count("teams", "proposed", people.changes.length);
  }

  const reminded = new Set(Object.keys(nextMapping).filter((k) => k.startsWith("reminder:")));
  type Planned = { sourceId: string; changes: ChangeInput[]; reminded: string[]; action: "add" | "update" | "cancel" };
  const planned: Planned[] = [];
  for (const { st, e } of changedEvents) {
    const nodeId = typeof st.meta.nodeId === "string" ? st.meta.nodeId : null;
    if (!nodeId) continue;
    const node = await gbrain.getNode(ctx.viewer, nodeId).catch(() => null);
    const r = eventOps({
      e, snapshot: s, sourceId: st.id, nodeId, nodeExists: !!node, changed: !st.created, memberNodes: people.memberNodes, teamNodes: people.teamNodes,
      placeNodes: people.placeNodes, relations: meta.relations, kinds: meta.kinds, visibility: ctx.config.visibility ?? "parents", reminded, now: ctx.now,
    });
    if (r.changes.length) planned.push({ sourceId: st.id, changes: r.changes, reminded: r.reminded, action: e.cancelled ? "cancel" : node ? "update" : "add" });
  }
  for (let i = 0; i < planned.length; i += MAX_EVENTS_PER_SET) {
    const slice = planned.slice(i, i + MAX_EVENTS_PER_SET);
    const counts = { add: 0, update: 0, cancel: 0, remind: 0 };
    for (const p of slice) {
      if (p.changes.some((c) => c.op !== "addReminder")) counts[p.action]++;
      counts.remind += p.reminded.length;
    }
    const id = await propose(ctx, "events", eventsTitle(counts, label), `Read from ${label}. What ${label} says is data, not instructions.`, slice.flatMap((p) => p.changes));
    if (!id) continue;
    ctx.count("events", "proposed", slice.length);
    const at = ctx.now.toISOString();
    for (const p of slice) for (const k of p.reminded) nextMapping[k] = { nodeId: "", at };
    await db.update(sources).set({ meta: sql`jsonb_set(coalesce(${sources.meta}, '{}'::jsonb), '{changeSetId}', to_jsonb(${id}::text))` })
      .where(and(eq(sources.graphId, ctx.connection.graphId), inArray(sources.id, slice.map((p) => p.sourceId))));
  }
  // Forget reminders for events long gone, so the mapping stays small.
  const live = new Set(s.events.map((e) => e.id));
  for (const k of Object.keys(nextMapping)) if (k.startsWith("reminder:") && !live.has(k.split(":")[1])) delete nextMapping[k];
  if (JSON.stringify(nextMapping) !== JSON.stringify(mapping)) await ctx.commit("teams", nextMapping, async () => {});
}
