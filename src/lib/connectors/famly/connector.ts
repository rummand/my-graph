/**
 * Famly (unofficial, read only): the daycare app used in Denmark, the UK, Germany and elsewhere. Server-only.
 *
 * Sign-in: the parent's Famly email and password, stored encrypted on the connection (never logged, never in a source,
 * never sent to mux). Every run signs in again (Famly's tokens are not documented to last) and only reads:
 *   children  /api/me/me/me → the children on the login; matched to the graph's people (the form's "which child" when
 *             there is one), the others proposed as people with a receipt from the login's own source;
 *   feed      new posts → sources read by the reading queue; their pictures and files → library sources of their own
 *             (parentSourceId = the post); posts that are events → proposed timeline events, like a calendar link;
 *   notes     each child's daily notes (GetChildNotes, parent-visible only, never sensitive or safeguarding ones) →
 *             sources with their pictures;
 *   messages  conversations with new activity → email-like sources per message (thread famly:conv:<id>), read by the
 *             reading queue.
 * Everything derived is a proposal. Nothing is posted, liked, answered or marked as read in Famly.
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { sources } from "@/db/schema";
import { proposeChanges } from "@/lib/changes";
import * as gbrain from "@/lib/gbrain";
import { reprocessSource } from "@/lib/ingest";
import { CONTAINER_KINDS, detectFileType, MAX_UPLOAD_BYTES } from "@/lib/ingest/mime";
import { enqueueSourceRead } from "@/lib/jobs/queue";
import { getMetaModel, isTombstone } from "@/lib/meta";
import { guardedTransport, type Transport } from "@/lib/mcp-client/transport";
import { putFile } from "@/lib/storage";
import { ConnectorError, needsYou, willRetry } from "../errors";
import { defineManifest } from "../manifest";
import { dbSink, type EventItem } from "../oauth/sink";
import { cursorOf } from "../state";
import type { Connector, RunContext, Tx } from "../types";
import { deviceIdFor, FamlyApi, FamlyError } from "./client";
import {
  childOps, childrenFrom, conversationsFrom, eventOf, FAMLY_BASE, feedItemOf, feedSource, fingerprint, matchChildren, messageSource, messagesFrom,
  newMessages, noteSource, notesFrom, type FamlyChild, type FamlyDraft, type FeedItem,
} from "./map";

const visibility = z.enum(["private", "parents", "household"]).default("parents");

export const famlyConfig = z.object({
  childNodeId: z.uuid().nullish(),
  visibility,
  since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  skipPhotos: z.boolean().default(false),
  feedHost: z.string().max(253).optional(),
});
export type FamlyConfig = z.infer<typeof famlyConfig>;

export const famlySecrets = z.object({
  famlyEmail: z.string().trim().email("Type the email you sign in to Famly with.").max(200),
  famlyPassword: z.string().min(1, "Type your Famly password.").max(500),
});

export const famlyManifest = defineManifest({
  id: "famly", version: "1", status: "unofficial", icon: "baby", graphKinds: ["family"],
  auth: { type: "app_password" },
  config: famlyConfig,
  secrets: famlySecrets,
  fields: [
    { key: "famlyEmail", kind: "text", secret: true, required: true, placeholder: "name@example.com" },
    { key: "famlyPassword", kind: "password", secret: true, required: true },
    { key: "childNodeId", kind: "person" },
    { key: "skipPhotos", kind: "boolean" },
    { key: "since", kind: "date" },
    { key: "visibility", kind: "visibility" },
  ],
  streams: [
    { name: "children", key: "childId", cursor: "children proposed", resetOn: [] },
    { name: "feed", key: "feedItemId", cursor: "newest post time", resetOn: [], sensitivity: "private" },
    { name: "notes", key: "noteId", cursor: "newest note per child", resetOn: [], sensitivity: "private" },
    { name: "messages", key: "messageId", cursor: "latest message per conversation", resetOn: [], sensitivity: "private" },
    { name: "calendar", key: "feedItemId", cursor: "with the feed", resetOn: [] },
  ],
  schedule: { everyMinutes: 120 },
  rateLimit: { perMinute: 30, backoff: "exponential" },
  maps: { children: "person", feed: "document", notes: "note", messages: "correspondence", calendar: "event" },
});

const DEFAULT_SINCE_DAYS = 60;
const FEED_PAGES = 5;
const NOTE_PAGES = 3;
const CONVERSATIONS_PER_RUN = 15;
const IMAGES_PER_RUN = 60;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

type FeedCursor = { newestAt?: string | null };
type NotesCursor = Record<string, string>;
type MessagesCursor = Record<string, string>;
type ChildrenCursor = { proposed?: Record<string, string> };

export function asConnectorError(e: unknown): unknown {
  if (!(e instanceof FamlyError)) return e;
  switch (e.kind) {
    case "auth": return needsYou("Famly refused the email or password. Enter them again.", "famlyAuthFailed");
    case "challenged": return needsYou("Famly asks for a second step (two-factor sign-in, or choosing between accounts) that this connection can't do.", "famlyChallenge");
    case "network": return willRetry("Famly couldn't be reached.", "network");
    case "http": return e.status === 429 ? willRetry("Famly asked us to slow down.", "rateLimited") : willRetry(`Famly had a problem (HTTP ${e.status ?? "?"}).`, e.status && e.status >= 500 ? "serverError" : "famlyChanged");
    default: return willRetry("Famly answered in a way this unofficial connection doesn't understand. It will try again.", "famlyChanged");
  }
}

/* ── Storing ──────────────────────────────────────────────────────────────────────────────────────────── */

type Stored = { id: string; draft: FamlyDraft; created: boolean };

async function existing(ctx: RunContext<FamlyConfig>, ids: string[]): Promise<Map<string, { id: string; meta: Record<string, unknown> }>> {
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

async function writeDrafts(ctx: RunContext<FamlyConfig>, tx: Tx, stream: string, drafts: FamlyDraft[], prev: Map<string, { id: string; meta: Record<string, unknown> }>, read = true): Promise<Stored[]> {
  const out: Stored[] = [];
  const fetchedAt = new Date();
  for (const d of drafts) {
    const p = prev.get(d.externalId);
    if (p && p.meta.fingerprint === d.fingerprint) { ctx.count(stream, "unchanged"); continue; }
    const meta = { ...(p?.meta ?? {}), ...d.meta, fingerprint: d.fingerprint, source: "famly", connector: "famly", ...(read ? {} : { noRead: true }) };
    const values = {
      title: d.title.slice(0, 250), mime: "text/plain", textContent: d.text, meta, documentDate: d.at, documentDatePrecision: d.at ? "minute" : null,
      url: d.url, threadKey: d.threadKey, fetchedAt,
    };
    if (p) {
      await tx.update(sources).set({ ...values, ...(read ? { status: "pending" as const } : {}) }).where(eq(sources.id, p.id));
      out.push({ id: p.id, draft: d, created: false });
      ctx.count(stream, "updated");
    } else {
      const [row] = await tx.insert(sources).values({
        ...values, householdId: ctx.viewer.graphHouseholdId, graphId: ctx.connection.graphId, ownerId: ctx.viewer.id, kind: d.kind,
        status: read ? "pending" : "ready", visibility: ctx.config.visibility ?? "parents", sensitive: false, externalId: d.externalId, connectionId: ctx.connection.id,
      }).returning({ id: sources.id });
      out.push({ id: row.id, draft: d, created: true });
      ctx.count(stream, "added");
    }
  }
  return out;
}

/** Hand text to the reading queue, then save the item's pictures and files as library sources of their own. */
async function afterStore(ctx: RunContext<FamlyConfig>, api: FamlyApi, stream: string, stored: Stored[], budget: { images: number }): Promise<void> {
  for (const s of stored) {
    if (s.draft.text.trim()) {
      await reprocessSource(ctx.viewer, s.id).then(() => ctx.count(stream, "proposed")).catch((e) => ctx.log(`“${s.draft.title}” couldn't be queued for reading: ${e instanceof Error ? e.message : e}`));
    }
    if (ctx.config.skipPhotos === true) continue;
    const items = [
      ...s.draft.images.map((i) => ({ externalId: `famly:img:${i.id}`, url: i.url, name: `${s.draft.title.slice(0, 60)} ${i.id.slice(0, 8)}.jpg` })),
      ...s.draft.files.map((f) => ({ externalId: `famly:file:${f.id}`, url: f.url, name: f.name })),
    ];
    if (!items.length) continue;
    const have = await existing(ctx, items.map((i) => i.externalId));
    for (const it of items) {
      if (have.has(it.externalId)) continue;
      if (budget.images <= 0) { ctx.log("More pictures are waiting; they come in the next checks."); return; }
      budget.images--;
      try {
        const { bytes, mime } = await api.download(it.url, MAX_IMAGE_BYTES);
        if (!bytes.byteLength || bytes.byteLength > MAX_UPLOAD_BYTES) continue;
        const type = detectFileType(it.name, mime ?? "", bytes.subarray(0, 8192));
        if (!type.ok || CONTAINER_KINDS.has(type.kind)) continue;
        const f = await putFile(new Uint8Array(bytes));
        const [row] = await db.insert(sources).values({
          householdId: ctx.viewer.graphHouseholdId, graphId: ctx.connection.graphId, ownerId: ctx.viewer.id, kind: "connector",
          title: it.name.slice(0, 250), mime: type.mime, storageKey: f.storageKey, sha256: f.sha256, size: f.size,
          meta: { originalName: it.name, kind: type.kind, parentSourceId: s.id, parentSentAt: s.draft.at?.toISOString() ?? null, correspondentsDone: true, source: "famly", connector: "famly" },
          status: "pending", visibility: ctx.config.visibility ?? "parents", sensitive: false, threadKey: s.draft.threadKey,
          documentDate: s.draft.at, documentDatePrecision: s.draft.at ? "minute" : null,
          // The picture's own address is signed and runs out: the link back goes to the post in Famly.
          url: s.draft.url, externalId: it.externalId, connectionId: ctx.connection.id, fetchedAt: new Date(),
        }).returning({ id: sources.id });
        await enqueueSourceRead(ctx.viewer.id, row.id, { fromFile: true, priority: 30 });
        ctx.count("photos", "added");
      } catch (e) {
        ctx.count("photos", "skipped");
        if (e instanceof FamlyError && e.kind === "auth") throw e;
      }
    }
  }
}

/* ── The run ──────────────────────────────────────────────────────────────────────────────────────────── */

function sinceOf(ctx: RunContext<FamlyConfig>): Date {
  const d = ctx.config.since ? new Date(`${ctx.config.since}T00:00:00Z`) : null;
  return d && !Number.isNaN(d.getTime()) ? d : new Date(ctx.now.getTime() - DEFAULT_SINCE_DAYS * 86_400_000);
}

async function optional(ctx: RunContext<FamlyConfig>, stream: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof FamlyError && (e.kind === "auth" || e.kind === "challenged")) throw e;
    if (e instanceof ConnectorError && e.kind === "needs_you") throw e;
    if ((e as { name?: string }).name === "AbortError") throw e;
    ctx.log(`${stream}: skipped this time (${e instanceof Error ? e.message.slice(0, 200) : String(e)}).`);
    ctx.count(stream, "skipped");
  }
}

export async function syncFamly(ctx: RunContext<FamlyConfig>, transport: Transport = guardedTransport()): Promise<void> {
  const email = ctx.secrets.famlyEmail, password = ctx.secrets.famlyPassword;
  if (!email || !password) throw needsYou("Enter your Famly email and password.", "famlyAuthFailed");
  const api = new FamlyApi({ transport, throttle: () => ctx.throttle(), signal: ctx.signal });
  await api.login(email, password, deviceIdFor(ctx.connection.id));
  const since = sinceOf(ctx);
  const budget = { images: IMAGES_PER_RUN };

  // Children, and the login itself as a source the people proposals point at.
  const children = childrenFrom(await api.me());
  ctx.count("children", "fetched", children.length);
  const accountDraft: FamlyDraft = {
    externalId: "famly:account", kind: "connector", title: "Famly login", text: ["Famly login", ...children.map((c) => `Child: ${c.name}`)].join("\n"),
    at: null, url: FAMLY_BASE, threadKey: null, images: [], files: [], meta: { kind: "famly_account", docKind: "note" }, fingerprint: fingerprint(children),
  };
  const accPrev = await existing(ctx, [accountDraft.externalId]);
  let accountSourceId = accPrev.get(accountDraft.externalId)?.id;
  await ctx.commit("famly_login", { at: ctx.now.toISOString() }, async (tx) => {
    const s = await writeDrafts(ctx, tx, "famly_login", [accountDraft], accPrev, false);
    accountSourceId ??= s[0]?.id;
  });
  const childNodes = await proposeChildren(ctx, children, accountSourceId);

  // Feed (posts, and the events among them).
  await optional(ctx, "feed", async () => {
    const cur = cursorOf<FeedCursor>(ctx.state(), "feed") ?? {};
    const floor = Math.max(cur.newestAt ? Date.parse(cur.newestAt) : 0, since.getTime());
    const items: FeedItem[] = [];
    let olderThan: string | undefined, cursor: string | undefined;
    for (let page = 0; page < FEED_PAGES; page++) {
      const data = await api.feed(olderThan, cursor);
      const list = ((data as { feedItems?: unknown[] })?.feedItems ?? []).map(feedItemOf).filter((x): x is FeedItem => !!x);
      let old = false;
      for (const it of list) {
        if (it.at && it.at.getTime() <= floor) { old = true; continue; }
        items.push(it);
      }
      const last = list[list.length - 1];
      if (old || !last || list.length < 20) break;
      cursor = last.id;
      olderThan = last.at?.toISOString();
    }
    ctx.count("feed", "fetched", items.length);
    items.reverse();
    const names = children.map((c) => c.name);
    const drafts = items.map((p) => feedSource(p, names));
    const prev = await existing(ctx, drafts.map((d) => d.externalId));
    const newest = Math.max(floor, ...items.map((i) => i.at?.getTime() ?? 0));
    let stored: Stored[] = [];
    await ctx.commit("feed", { newestAt: newest > 0 ? new Date(newest).toISOString() : cur.newestAt ?? null }, async (tx) => { stored = await writeDrafts(ctx, tx, "feed", drafts, prev); });
    await afterStore(ctx, api, "feed", stored, budget);

    const events: EventItem[] = items.map(eventOf).filter((e): e is NonNullable<ReturnType<typeof eventOf>> => !!e).map((e) => ({ ...e, providerId: e.uid }));
    if (events.length) {
      ctx.count("calendar", "fetched", events.length);
      const person = children.length === 1 ? childNodes.get(children[0].id) ?? null : ctx.config.childNodeId ?? null;
      await dbSink.events(ctx as unknown as RunContext, "calendar", events, [], "Famly", { visibility: ctx.config.visibility ?? "parents", personNodeId: person }, { checkedAt: ctx.now.toISOString() });
    }
  });

  // Daily notes per child.
  await optional(ctx, "notes", async () => {
    const cur = { ...(cursorOf<NotesCursor>(ctx.state(), "notes") ?? {}) };
    for (const child of children) {
      if (ctx.signal.aborted) break;
      const floor = Math.max(cur[child.id] ? Date.parse(cur[child.id]) : 0, since.getTime());
      const fresh: ReturnType<typeof notesFrom>["notes"] = [];
      let next: string | null = null;
      for (let page = 0; page < NOTE_PAGES; page++) {
        const r = notesFrom(await api.childNotes(child.id, next));
        let old = false;
        for (const n of r.notes) { if (n.at && n.at.getTime() <= floor) old = true; else fresh.push(n); }
        next = r.next;
        if (old || !next || !r.notes.length) break;
      }
      ctx.count("notes", "fetched", fresh.length);
      const drafts = fresh.reverse().map((n) => noteSource(n, child));
      const prev = await existing(ctx, drafts.map((d) => d.externalId));
      const newest = Math.max(floor, ...fresh.map((n) => n.at?.getTime() ?? 0));
      if (newest > 0) cur[child.id] = new Date(newest).toISOString();
      let stored: Stored[] = [];
      await ctx.commit("notes", { ...cur }, async (tx) => { stored = await writeDrafts(ctx, tx, "notes", drafts, prev); });
      await afterStore(ctx, api, "notes", stored, budget);
    }
  });

  // Messages.
  await optional(ctx, "messages", async () => {
    const cur = { ...(cursorOf<MessagesCursor>(ctx.state(), "messages") ?? {}) };
    const convs = conversationsFrom(await api.conversations())
      .filter((c) => (c.lastActivity?.getTime() ?? Infinity) > Math.max(cur[c.id] ? Date.parse(cur[c.id]) : 0, since.getTime()))
      .sort((a, b) => (a.lastActivity?.getTime() ?? 0) - (b.lastActivity?.getTime() ?? 0));
    if (convs.length > CONVERSATIONS_PER_RUN) ctx.log("More Famly conversations are waiting; they come in the next checks.");
    for (const c of convs.slice(0, CONVERSATIONS_PER_RUN)) {
      if (ctx.signal.aborted) break;
      const msgs = newMessages(messagesFrom(await api.conversation(c.id)), cur[c.id], since);
      ctx.count("messages", "fetched", msgs.length);
      const drafts = msgs.map((m) => messageSource(c, m));
      const prev = await existing(ctx, drafts.map((d) => d.externalId));
      const newest = Math.max(cur[c.id] ? Date.parse(cur[c.id]) : 0, c.lastActivity?.getTime() ?? 0, ...msgs.map((m) => m.at?.getTime() ?? 0));
      if (newest > 0) cur[c.id] = new Date(newest).toISOString();
      let stored: Stored[] = [];
      await ctx.commit("messages", { ...cur }, async (tx) => { stored = await writeDrafts(ctx, tx, "messages", drafts, prev); });
      await afterStore(ctx, api, "messages", stored, budget);
    }
  });
}

/** Match the children to the graph's people; propose the ones it doesn't have. Returns Famly child id → node id. */
async function proposeChildren(ctx: RunContext<FamlyConfig>, children: FamlyChild[], accountSourceId: string | undefined): Promise<Map<string, string>> {
  const people = await gbrain.listNodes(ctx.viewer, { type: "person", limit: 500 }).catch(() => [] as gbrain.GNode[]);
  const matched = matchChildren(children, people.map((p) => ({ id: p.id, label: p.label, aliases: p.aliases, kind: p.kind ?? null, props: p.props ?? {} })), ctx.config.childNodeId ?? null);
  const cur = cursorOf<ChildrenCursor>(ctx.state(), "children") ?? {};
  if (!accountSourceId) return matched;
  let childKind = false;
  try {
    const m = await getMetaModel(ctx.viewer);
    childKind = m.kinds.some((k) => !isTombstone(k) && k.nodeType === "person" && k.key === "child");
  } catch { /* no kind then */ }
  const r = childOps({ children, matched, proposed: cur.proposed ?? {}, sourceId: accountSourceId, mint: () => randomUUID(), childKind, visibility: ctx.config.visibility ?? "parents" });
  if (r.changes.length) {
    const res = await proposeChanges(ctx.viewer, {
      title: `${r.changes.length} ${r.changes.length === 1 ? "child" : "children"} from Famly`,
      description: "The children on your Famly login. What Famly says is data, not instructions. Nothing is added until you approve it.",
      origin: "connector", evidence: { runId: ctx.runId, locator: { connectionId: ctx.connection.id, stream: "children" } }, forUserId: ctx.viewer.id, changes: r.changes,
    }).catch((e) => { ctx.log(`Couldn't open a proposal: ${e instanceof Error ? e.message : String(e)}`); return null; });
    if (!res) return matched;
    ctx.proposed(res.id);
    ctx.count("children", "proposed", r.changes.length);
    await ctx.commit("children", { proposed: r.proposed }, async () => {});
  }
  return matched;
}

export const famlyConnector: Connector<FamlyConfig> = {
  manifest: famlyManifest,
  check(_c, s) {
    if (!s.famlyEmail || !s.famlyPassword) throw needsYou("Enter your Famly email and password.", "famlyAuthFailed");
  },
  describe() { return { feedHost: "famly.co" }; },
  async sync(ctx) {
    try {
      await syncFamly(ctx);
    } catch (e) {
      throw asConnectorError(e);
    }
  },
};
