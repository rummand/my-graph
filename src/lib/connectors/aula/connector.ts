/**
 * Aula messages (unofficial, read only, for our own family). Server-only.
 *
 * Sign-in: the parent runs the Connect Aula helper at home (MitID on their own phone, from a Danish home connection,
 * because STIL's bot check blocks servers). The helper hands My Graph only the OAuth tokens, with a one-time pairing
 * code (pairing.ts). The tokens are stored encrypted on the connection; MitID itself never reaches My Graph.
 *
 * Every run (at most every 15 minutes): refresh the tokens when they are about to end (a refused refresh = "Needs
 * you: reconnect Aula", never an automatic MitID retry); find Aula's API version (410 → probe); then, read only:
 *   threads   new messages since the cursor → email-like sources (thread key, sender, recipients, institution, child),
 *             each handed to the reading queue, which proposes people, dates and reminders with receipts; sensitive
 *             threads become a "Sensitive, open in Aula" placeholder and are never opened or read;
 *   posts     new posts → sources for the reading queue;
 *   calendar  49-day windows → event sources and a change set (events, the children involved, "reply by" reminders);
 *   presence  today's sick / pick-up per child → a dated source (a mark on the timeline);
 *   gallery   new albums → links to Aula (nothing downloaded);
 *   people    the children, their school or daycare, and the staff and parents who wrote → one change set.
 * Every source carries url, externalId, connectionId and fetchedAt; everything derived is a proposal. Nothing is ever
 * written to Aula, and nothing marks a thread as read (see client.ts).
 */
import { sourceTitleKey } from "@/lib/ingest/titles";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, like, notInArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { connections, edges, sources } from "@/db/schema";
import { proposeChanges, type ChangeInput } from "@/lib/changes";
import * as gbrain from "@/lib/gbrain";
import { reprocessSource } from "@/lib/ingest";
import { guardedTransport, type Transport } from "@/lib/mcp-client/transport";
import { getMetaModel, isTombstone } from "@/lib/meta";
import { encryptSecrets } from "../crypto";
import { ConnectorError, needsYou, willRetry } from "../errors";
import { defineManifest } from "../manifest";
import { cursorOf } from "../state";
import type { Connector, RunContext, Tx } from "../types";
import { AulaApi, AulaError } from "./client";
import { aulaBases, type AulaBases } from "./constants";
import { copenhagenDay, type PostsCursor, type ThreadsCursor } from "./cursor";
import {
  accountFrom, albumSource, eventOps, eventSource, fingerprint, messageSource, peopleOps, postSource, presenceSource, scopeIds,
  sensitiveSource, type AulaAccount, type KnownNode, type PeopleMapping, type SeenPerson, type SourceDraft,
} from "./mapping";
import { readCalendar, readGallery, readPosts, readPresence, readThreads } from "./read";
import { aulaSecrets, needsRefresh, refreshTokens, tokensFrom, toSecrets, type AulaTokenSet } from "./tokens";

export const aulaConfig = z.object({
  visibility: z.enum(["private", "parents", "household"]).default("parents"),
  since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  streams: z.object({
    posts: z.boolean().default(true), calendar: z.boolean().default(true), presence: z.boolean().default(true), gallery: z.boolean().default(true),
  }).partial().optional(),
  /** Pairing in progress: the hash of the one-time code the helper must send, and when it ends. */
  pairing: z.object({ hash: z.string().regex(/^[0-9a-f]{64}$/), expiresAt: z.string() }).nullish(),
  /** Who Aula says is signed in (shown on the connection; names only). */
  account: z.object({ name: z.string().nullable(), children: z.array(z.object({ name: z.string(), institution: z.string().nullable() })) }).optional(),
  apiVersion: z.number().int().min(1).max(999).optional(),
  /** A local mock of Aula, used only where connectors may reach this computer (development). Ignored elsewhere. */
  aulaBase: z.string().url().max(200).optional(),
  feedHost: z.string().max(253).optional(),
});
export type AulaConfig = z.infer<typeof aulaConfig>;

export const aulaManifest = defineManifest({
  id: "aula", version: "1", status: "unofficial", icon: "school", graphKinds: ["family"],
  auth: { type: "mitid_session" },
  config: aulaConfig,
  secrets: aulaSecrets,
  fields: [{ key: "visibility", kind: "visibility" }],
  streams: [
    // Aula's 410 means "API version retired", handled by probing (client.ts), not by resetting a cursor.
    { name: "threads", key: "messageId", cursor: "latestMessageAt + per-thread latest", resetOn: [] },
    { name: "posts", key: "postId", cursor: "newestAt", resetOn: [] },
    { name: "calendar", key: "eventId", cursor: "49-day windows", resetOn: [] },
    { name: "presence", key: "child+day", cursor: "today", resetOn: [], sensitivity: "private" },
    { name: "gallery", key: "albumId", cursor: "known albums", resetOn: [], sensitivity: "private" },
  ],
  schedule: { everyMinutes: 15 },
  rateLimit: { perMinute: 30, backoff: "exponential" },
  maps: { threads: "correspondence", posts: "document", calendar: "event", presence: "event", gallery: "photo" },
});

const DEFAULT_SINCE_DAYS = 90;

/* ── Errors ───────────────────────────────────────────────────────────────────────────────────────────── */

export const reconnect = () => needsYou("Aula ended the sign-in. Reconnect Aula: open Connections, Aula messages, and sign in with MitID again.", "aulaReconnect");

/** Aula's errors in the connectors' two kinds. Auth never retries by itself: MitID needs the parent. */
export function asConnectorError(e: unknown): unknown {
  if (!(e instanceof AulaError)) return e;
  switch (e.kind) {
    case "auth": return reconnect();
    case "deactivated": return needsYou("Aula says this login is deactivated.", "aulaDeactivated");
    case "version": return willRetry("Aula changed its API and no working version was found yet. It will try again; this connection is unofficial and may stop working.", "aulaVersion");
    case "network": return willRetry("Aula couldn't be reached.", "network");
    case "http": return e.status === 429 ? willRetry("Aula asked us to slow down.", "rateLimited") : willRetry(`Aula had a problem (HTTP ${e.status ?? "?"}).`, "serverError");
    default: return willRetry(e.message);
  }
}

/* ── Tokens ───────────────────────────────────────────────────────────────────────────────────────────── */

async function saveTokens(connectionId: string, t: AulaTokenSet): Promise<void> {
  await db.update(connections).set({ secrets: encryptSecrets(toSecrets(t), connectionId), updatedAt: new Date() }).where(eq(connections.id, connectionId));
}

/** Refresh when needed (or when forced after Aula said the token ended). The new tokens are saved right away. */
async function fresh(ctx: RunContext<AulaConfig>, transport: Transport, bases: AulaBases, t: AulaTokenSet, force = false): Promise<AulaTokenSet> {
  if (!force && !needsRefresh(t)) return t;
  const next = await refreshTokens(transport, bases.auth, t.refreshToken, { signal: ctx.signal });
  await saveTokens(ctx.connection.id, next);
  ctx.log("Renewed the Aula sign-in.");
  return next;
}

/* ── Storing sources ──────────────────────────────────────────────────────────────────────────────────── */

type Stored = { id: string; draft: SourceDraft; created: boolean; meta: Record<string, unknown> };

async function existingByExternal(ctx: RunContext<AulaConfig>, ids: string[]): Promise<Map<string, { id: string; meta: Record<string, unknown> }>> {
  const out = new Map<string, { id: string; meta: Record<string, unknown> }>();
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
async function writeDrafts(ctx: RunContext<AulaConfig>, tx: Tx, stream: string, drafts: SourceDraft[], existing: Map<string, { id: string; meta: Record<string, unknown> }>): Promise<Stored[]> {
  const out: Stored[] = [];
  const fetchedAt = new Date();
  const seen = new Set<string>();
  for (const d of drafts) {
    if (seen.has(d.externalId)) continue;
    seen.add(d.externalId);
    const prev = existing.get(d.externalId);
    if (prev && prev.meta.fingerprint === d.fingerprint) { ctx.count(stream, "unchanged"); continue; }
    const readable = !!d.text && !d.sensitive && !d.meta.noRead;
    const meta = { ...(prev?.meta ?? {}), ...d.meta, fingerprint: d.fingerprint, source: "aula" };
    const values = {
      title: d.title.slice(0, 250), mime: d.mime, textContent: d.text, meta, sensitive: d.sensitive,
      documentDate: d.documentDate, documentDatePrecision: d.precision, url: d.url, threadKey: d.threadKey, fetchedAt,
    };
    if (prev) {
      await tx.update(sources).set({ ...values, ...(readable ? { status: "pending" as const } : {}) }).where(eq(sources.id, prev.id));
      out.push({ id: prev.id, draft: d, created: false, meta });
      ctx.count(stream, "updated");
    } else {
      const [row] = await tx.insert(sources).values({
        ...values, householdId: ctx.viewer.graphHouseholdId, graphId: ctx.connection.graphId, ownerId: ctx.viewer.id, kind: d.kind,
        status: readable ? "pending" : "ready", visibility: ctx.config.visibility ?? "parents", externalId: d.externalId, connectionId: ctx.connection.id,
      }).returning({ id: sources.id });
      out.push({ id: row.id, draft: d, created: true, meta });
      ctx.count(stream, "added");
    }
  }
  return out;
}

/** Hand new and changed letters to the reading queue (it proposes people, dates and reminders, with receipts). */
async function queueReading(ctx: RunContext<AulaConfig>, stream: string, stored: Stored[]): Promise<void> {
  for (const s of stored) {
    if (!s.draft.text || s.draft.sensitive || s.draft.meta.noRead) continue;
    await reprocessSource(ctx.viewer, s.id).then(() => ctx.count(stream, "proposed"))
      .catch((e) => ctx.log(`“${s.draft.title}” couldn't be queued for reading: ${e instanceof Error ? e.message : e}`));
  }
}

/* ── The run ──────────────────────────────────────────────────────────────────────────────────────────── */

type Session = { api: AulaApi; account: AulaAccount; bases: AulaBases };

async function open(ctx: RunContext<AulaConfig>, transport: Transport): Promise<Session> {
  const bases = aulaBases(ctx.config.aulaBase);
  let tokens = tokensFrom(ctx.secrets);
  if (!tokens) throw reconnect();
  tokens = await fresh(ctx, transport, bases, tokens);
  let versionNote: string | null = null;
  const make = () => new AulaApi({
    transport, apiBase: bases.api, accessToken: () => tokens!.accessToken, version: ctx.config.apiVersion ?? null, throttle: () => ctx.throttle(), signal: ctx.signal,
    onVersionChanged: (from, to) => { versionNote = `Aula moved its API from v${from} to v${to}.`; },
  });
  let api = make();
  let data: unknown;
  try {
    data = await api.profilesByLogin();
  } catch (e) {
    if (!(e instanceof AulaError && e.kind === "auth")) throw e;
    // The access token ended early: one refresh, one more try. A second refusal needs the parent.
    tokens = await fresh(ctx, transport, bases, tokens, true);
    api = make();
    data = await api.profilesByLogin();
  }
  if (versionNote) ctx.log(versionNote);
  const account = accountFrom(data);
  const summary = { name: account.name, children: account.children.map((c) => ({ name: c.name, institution: c.institutionName })) };
  const changed = api.apiVersion !== ctx.config.apiVersion || JSON.stringify(summary) !== JSON.stringify(ctx.config.account ?? null);
  if (changed) {
    await db.update(connections).set({
      config: sql`coalesce(${connections.config}, '{}'::jsonb) || ${JSON.stringify({ apiVersion: api.apiVersion, account: summary })}::jsonb`, updatedAt: new Date(),
    }).where(eq(connections.id, ctx.connection.id));
  }
  return { api, account, bases };
}

function sinceOf(ctx: RunContext<AulaConfig>): Date {
  if (ctx.config.since) {
    const d = new Date(`${ctx.config.since}T00:00:00Z`);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date(ctx.now.getTime() - DEFAULT_SINCE_DAYS * 86_400_000);
}

const streamOn = (ctx: RunContext<AulaConfig>, s: "posts" | "calendar" | "presence" | "gallery") => ctx.config.streams?.[s] !== false;

/** An optional stream that fails (Aula changed something) is logged and skipped; a sign-in problem stops the run. */
async function optional(ctx: RunContext<AulaConfig>, stream: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof AulaError && (e.kind === "auth" || e.kind === "deactivated")) throw e;
    if (e instanceof ConnectorError && e.kind === "needs_you") throw e;
    if ((e as { name?: string }).name === "AbortError") throw e;
    ctx.log(`${stream}: skipped this time (${e instanceof Error ? e.message.slice(0, 200) : String(e)}).`);
    ctx.count(stream, "skipped");
  }
}

export async function syncAula(ctx: RunContext<AulaConfig>, transport: Transport = guardedTransport()): Promise<void> {
  const { api, account, bases } = await open(ctx, transport);
  const web = bases.web;
  const since = sinceOf(ctx);
  const scope = scopeIds(account);
  const seen: SeenPerson[] = [];

  // The login itself, as a source the people proposals can point at.
  const accountDraft: SourceDraft = {
    externalId: "aula:account", kind: "connector", title: `Aula: ${account.name ?? "your login"}`, mime: "text/plain",
    text: [`Aula login: ${account.name ?? "unknown"}`, ...account.children.map((c) => `Child: ${c.name}${c.institutionName ? `, ${c.institutionName}` : ""}`)].join("\n"),
    sensitive: false, documentDate: null, precision: null, url: web, threadKey: null,
    meta: { kind: "aula_account", noRead: true, ...(account.name ? sourceTitleKey("aulaAccount", { name: account.name }) : sourceTitleKey("aulaAccountUnknown")) },
    fingerprint: fingerprint([account.name, account.children]),
  };
  const accountExisting = await existingByExternal(ctx, [accountDraft.externalId]);
  let accountSourceId = accountExisting.get(accountDraft.externalId)?.id;
  await ctx.commit("profile", { at: ctx.now.toISOString() }, async (tx) => {
    const s = await writeDrafts(ctx, tx, "profile", [accountDraft], accountExisting);
    accountSourceId ??= s[0]?.id;
  });

  // Threads → messages.
  const tcur = cursorOf<ThreadsCursor>(ctx.state(), "threads") ?? {};
  const threads = await readThreads(api, tcur, { since, now: ctx.now, signal: ctx.signal });
  ctx.count("threads", "fetched", threads.items.reduce((n, i) => n + Math.max(1, i.read.messages.length), 0));
  const msgExisting = await existingByExternal(ctx, threads.items.flatMap((i) => (i.read.sensitive ? [`aula:sensitive:${i.read.thread.id}`] : i.read.messages.map((m) => `aula:msg:${m.id}`))));
  for (const [n, item] of threads.items.entries()) {
    const { read } = item;
    const drafts = read.sensitive ? [sensitiveSource(read.thread, web)] : read.messages.map((m) => messageSource(read.thread, m, web));
    const last = n === threads.items.length - 1;
    let stored: Stored[] = [];
    await ctx.commit("threads", last ? threads.final : item.cursor, async (tx) => { stored = await writeDrafts(ctx, tx, "threads", drafts, msgExisting); });
    if (read.sensitive) ctx.log(`A sensitive thread was kept as “Sensitive, open in Aula”; it is never opened or read here.`);
    await queueReading(ctx, "threads", stored);
    if (!read.sensitive) {
      for (const m of read.messages) {
        const who = m.sender ?? read.thread.creator;
        if (who) seen.push({ ...who, institution: read.thread.institution, children: read.thread.children, sourceExternalId: `aula:msg:${m.id}`, quote: `${who.name}${who.hint ? ` (${who.hint})` : ""}: ${m.text.slice(0, 140)}`, locator: { aula: { threadId: read.thread.id, messageId: m.id } } });
      }
    }
  }
  if (!threads.items.length && JSON.stringify(threads.final) !== JSON.stringify(tcur)) await ctx.commit("threads", threads.final, async () => {});
  if (threads.more) ctx.log("More Aula threads are waiting; they come in the next checks.");

  // Posts.
  if (streamOn(ctx, "posts")) await optional(ctx, "posts", async () => {
    const pcur = cursorOf<PostsCursor>(ctx.state(), "posts") ?? {};
    const { posts, next } = await readPosts(api, pcur, scope, since);
    ctx.count("posts", "fetched", posts.length);
    const drafts = posts.map((p) => postSource(p, web));
    const existing = await existingByExternal(ctx, drafts.map((d) => d.externalId));
    let stored: Stored[] = [];
    await ctx.commit("posts", next, async (tx) => { stored = await writeDrafts(ctx, tx, "posts", drafts, existing); });
    await queueReading(ctx, "posts", stored);
    for (const p of posts) if (p.author) seen.push({ ...p.author, institution: p.institution, children: [], sourceExternalId: `aula:post:${p.id}`, quote: `${p.author.name}: ${p.title}`, locator: { aula: { postId: p.id } } });
  });

  // People (before the calendar, so its events can involve the children).
  const childNodes = await proposePeople(ctx, account, seen, accountSourceId);

  // Calendar.
  if (streamOn(ctx, "calendar")) await optional(ctx, "calendar", async () => {
    const events = await readCalendar(api, scope, ctx.now);
    ctx.count("calendar", "fetched", events.length);
    const nameOf = new Map(account.children.map((c) => [c.institutionProfileId ?? c.id, c]));
    const drafts = events.map((e) => eventSource(e, web, e.profileIds.map((id) => nameOf.get(id)?.name).filter((x): x is string => !!x)));
    const existing = await existingByExternal(ctx, drafts.map((d) => d.externalId));
    let stored: Stored[] = [];
    await ctx.commit("calendar", { checkedAt: ctx.now.toISOString() }, async (tx) => {
      stored = await writeDrafts(ctx, tx, "calendar", drafts, existing);
      for (const s of stored) if (typeof s.meta.nodeId !== "string") {
        s.meta.nodeId = randomUUID();
        await tx.update(sources).set({ meta: s.meta }).where(eq(sources.id, s.id));
      }
    });
    await proposeEvents(ctx, stored, events, childNodes, nameOf);
  });

  // Presence today.
  if (streamOn(ctx, "presence")) await optional(ctx, "presence", async () => {
    const day = copenhagenDay(ctx.now);
    const rows = await readPresence(api, account);
    ctx.count("presence", "fetched", rows.length);
    const drafts = rows.map((r) => presenceSource(r.entry, { id: r.childId, name: r.name }, day, web)).filter((d): d is SourceDraft => !!d);
    const existing = await existingByExternal(ctx, drafts.map((d) => d.externalId));
    await ctx.commit("presence", { day }, async (tx) => { await writeDrafts(ctx, tx, "presence", drafts, existing); });
  });

  // Gallery: links only.
  if (streamOn(ctx, "gallery")) await optional(ctx, "gallery", async () => {
    const rows = await db.select({ externalId: sources.externalId }).from(sources)
      .where(and(eq(sources.graphId, ctx.connection.graphId), eq(sources.connectionId, ctx.connection.id), like(sources.externalId, "aula:album:%")));
    const known = new Set(rows.map((r) => r.externalId!.slice("aula:album:".length)));
    const albums = await readGallery(api, scope, known);
    ctx.count("gallery", "fetched", albums.length);
    const drafts = albums.map((a) => albumSource(a.album, web, a.mediaIds));
    await ctx.commit("gallery", { checkedAt: ctx.now.toISOString() }, async (tx) => { await writeDrafts(ctx, tx, "gallery", drafts, new Map()); });
  });
}

/* ── Proposals ────────────────────────────────────────────────────────────────────────────────────────── */

async function metaSets(ctx: RunContext<AulaConfig>): Promise<{ relations: Set<string>; kinds: Set<string> }> {
  try {
    const m = await getMetaModel(ctx.viewer);
    return {
      relations: new Set(m.relations.filter((r) => !isTombstone(r)).map((r) => r.key)),
      kinds: new Set(m.kinds.filter((k) => !isTombstone(k)).map((k) => `${k.nodeType}:${k.key}`)),
    };
  } catch {
    return { relations: new Set(["involves", "attends", "parent_of", "teacher_of"]), kinds: new Set() };
  }
}

/** Children, institutions and writers as one change set. Returns Aula child id → graph node id. */
async function proposePeople(ctx: RunContext<AulaConfig>, account: AulaAccount, seen: SeenPerson[], accountSourceId: string | undefined): Promise<Map<number, string>> {
  const mapping = cursorOf<PeopleMapping>(ctx.state(), "people") ?? {};
  const [persons, places, meta] = await Promise.all([
    gbrain.listNodes(ctx.viewer, { type: "person", limit: 1000 }).catch(() => []),
    gbrain.listNodes(ctx.viewer, { type: "place", limit: 500 }).catch(() => []),
    metaSets(ctx),
  ]);
  const known: KnownNode[] = [...persons, ...places].map((n) => ({ id: n.id, type: n.type, label: n.label, aliases: n.aliases, kind: n.kind ?? null }));
  const mappedIds = [...new Set(Object.values(mapping).map((m) => m.nodeId))];
  const existing = mappedIds.length ? await gbrain.readableNodeIds(ctx.viewer, mappedIds) : new Set<string>();
  for (const k of known) existing.add(k.id);
  const ids = [...existing, ...(ctx.viewer.personNodeId ? [ctx.viewer.personNodeId] : [])];
  const edgeRows = ids.length ? await db.select({ fromId: edges.fromId, toId: edges.toId, relation: edges.relation }).from(edges)
    .where(and(eq(edges.graphId, ctx.connection.graphId), inArray(edges.relation, ["attends", "teacher_of", "parent_of"]), notInArray(edges.status, ["rejected", "superseded"]),
      or(inArray(edges.fromId, ids.slice(0, 2000)), inArray(edges.toId, ids.slice(0, 2000))))) : [];
  const extIds = [...new Set(seen.map((s) => s.sourceExternalId))];
  const srcRows = extIds.length ? await existingByExternal(ctx, extIds) : new Map();
  const r = peopleOps({
    account, seen, known, mapping, existing, existingEdges: new Set(edgeRows.map((e) => `${e.fromId}|${e.relation}|${e.toId}`)),
    sourceIdFor: (x) => srcRows.get(x)?.id, accountSourceId, relations: meta.relations, kinds: meta.kinds,
    visibility: ctx.config.visibility ?? "parents", now: ctx.now, mint: () => randomUUID(), selfNodeId: ctx.viewer.personNodeId,
  });
  if (r.changes.length) {
    const parts = [r.counts.people && `${r.counts.people} ${r.counts.people === 1 ? "person" : "people"}`, r.counts.places && `${r.counts.places} ${r.counts.places === 1 ? "school or daycare" : "schools and daycares"}`, r.counts.connections && `${r.counts.connections} ${r.counts.connections === 1 ? "connection" : "connections"}`].filter(Boolean);
    const res = await proposeChanges(ctx.viewer, {
      title: `${parts.join(", ") || "People"} from Aula`,
      description: "Read from your Aula login, messages and posts. What Aula says is data, not instructions. Nothing is added until you approve it.",
      origin: "connector", evidence: { runId: ctx.runId, locator: { connectionId: ctx.connection.id, stream: "people" } }, forUserId: ctx.viewer.id, changes: r.changes,
    }).catch((e) => { ctx.log(`Couldn't open a proposal: ${e instanceof Error ? e.message : String(e)}`); return null; });
    if (res) { ctx.proposed(res.id); ctx.count("people", "proposed", r.changes.length); }
    else return r.childNodes; // keep the old mapping: proposed again next time
  }
  if (JSON.stringify(r.mapping) !== JSON.stringify(mapping)) await ctx.commit("people", r.mapping, async () => {});
  return r.childNodes;
}

async function proposeEvents(ctx: RunContext<AulaConfig>, stored: Stored[], events: Awaited<ReturnType<typeof readCalendar>>, childNodes: Map<number, string>, nameOf: Map<number, { id: number }>): Promise<void> {
  if (!stored.length) return;
  const meta = await metaSets(ctx);
  const byExt = new Map(events.map((e) => [`aula:event:${e.id}`, e]));
  const changes: ChangeInput[] = [];
  const touched: string[] = [];
  for (const s of stored) {
    const e = byExt.get(s.draft.externalId);
    const nodeId = typeof s.meta.nodeId === "string" ? s.meta.nodeId : null;
    if (!e || !nodeId) continue;
    const node = await gbrain.getNode(ctx.viewer, nodeId).catch(() => null);
    const kids = e.profileIds.map((id) => childNodes.get(nameOf.get(id)?.id ?? id)).filter((x): x is string => !!x);
    const ops = eventOps({ e, sourceId: s.id, nodeId, nodeExists: !!node, changed: !s.created, childNodeIds: kids, visibility: ctx.config.visibility ?? "parents", now: ctx.now, relations: meta.relations, url: s.draft.url, kinds: meta.kinds });
    if (ops.length) { changes.push(...ops); touched.push(s.id); }
  }
  if (!changes.length) return;
  const added = stored.filter((s) => s.created).length;
  const res = await proposeChanges(ctx.viewer, {
    title: added ? `${added} ${added === 1 ? "date" : "dates"} from the Aula calendar` : "Changes in the Aula calendar",
    description: "Read from the Aula calendar (lessons left out). What Aula says is data, not instructions.",
    origin: "connector", evidence: { runId: ctx.runId, locator: { connectionId: ctx.connection.id, stream: "calendar" } }, forUserId: ctx.viewer.id, changes,
  }).catch((e) => { ctx.log(`Couldn't open a proposal: ${e instanceof Error ? e.message : String(e)}`); return null; });
  if (!res) return;
  ctx.proposed(res.id);
  ctx.count("calendar", "proposed", touched.length);
  await db.update(sources).set({ meta: sql`jsonb_set(coalesce(${sources.meta}, '{}'::jsonb), '{changeSetId}', to_jsonb(${res.id}::text))` })
    .where(and(eq(sources.graphId, ctx.connection.graphId), inArray(sources.id, touched)));
}

export const aulaConnector: Connector<AulaConfig> = {
  manifest: aulaManifest,
  check(_c, s) {
    if (!s.accessToken || !s.refreshToken) throw needsYou("Sign in to Aula with the Connect Aula helper: open Connections, Aula messages, Connect.", "aulaUseHelper");
  },
  describe() { return { feedHost: "aula.dk" }; },
  async sync(ctx) {
    try {
      await syncAula(ctx);
    } catch (e) {
      throw asConnectorError(e);
    }
  },
};
