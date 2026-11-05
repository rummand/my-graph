/**
 * My Graph for Mac, server side (server-only).
 *
 * 1. On /connections/mac the person asks for a pairing code (startMacPairing). That makes (or reuses) their one Mac
 *    connection in this graph and stores only a hash of the code, valid 15 minutes.
 * 2. The helper on their Mac sends the code (acceptPairing) and gets a helper token back, once. Only its hash is kept
 *    (config.helper.tokenHash). Pairing again replaces it; disconnecting deletes the row and with it the token.
 * 3. Every helper call (helperAuth) finds the connection by the token's hash and re-checks, every time, that the
 *    person still exists, is still a member of that graph and may still write in it (viewerFor + scopeOf), and that
 *    the connection isn't paused. The helper then sends its list of conversations (no messages), asks what to send,
 *    and sends batches: each is kept as a library source (importPayload) and read by its importer, which proposes a
 *    change set. Agents propose, humans decide.
 */
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { connectionRuns, connections } from "@/db/schema";
import { audit, type Viewer } from "@/lib/auth";
import { AttemptLimiter } from "@/lib/auth/rate-limit";
import { viewerFor } from "@/lib/auth/viewer-for";
import * as gbrain from "@/lib/gbrain";
import { scopeOf } from "@/lib/graphs/pure";
import { appleNotesPayload, imessagePayload } from "@/lib/importers/schemas";
import { importPayload } from "@/lib/importers/server";
import type { ImportKnown } from "@/lib/importers/types";
import { IngestError } from "@/lib/ingest/errors";
import { encryptSecrets } from "../crypto";
import { readState, resetStream, withCursor, type ConnectionState } from "../state";
import { ConnectionError, getConnection, type ConnectionDTO } from "../store";
import type { ConnectionRow } from "../types";
import {
  MAC_CONNECTOR, PAIRING_MINUTES, allowedChats, batchTitle, bearerToken, chatHasKnownPerson, cleanDevice, filterChats, filterNotes,
  helperSettings, macConfig, messagesCursor, newHelperToken, newPairingCode, nextMessagesCursor, nextNotesCursor, notesCursor, pairingHash,
  tokenHash, type BatchEnvelope, type CatalogBody, type HelperSettings, type MacConfig, type Since,
} from "./config";

const g = globalThis as unknown as { __mgMacPairIp?: AttemptLimiter; __mgMacPairAll?: AttemptLimiter; __mgMacBadToken?: AttemptLimiter };
const pairPerAddress = g.__mgMacPairIp ?? (g.__mgMacPairIp = new AttemptLimiter(10, 15 * 60_000));
const pairOverall = g.__mgMacPairAll ?? (g.__mgMacPairAll = new AttemptLimiter(60, 15 * 60_000));
const badTokens = g.__mgMacBadToken ?? (g.__mgMacBadToken = new AttemptLimiter(30, 15 * 60_000));

function assertMayConnect(v: Viewer) {
  if (v.role === "guest") throw new ConnectionError(403, "Guests can't connect accounts.");
  if (!scopeOf(v).canWrite) throw new ConnectionError(403, "You can look at this graph but not connect accounts to it.");
}

async function ownMac(v: Viewer): Promise<ConnectionRow | null> {
  const [row] = await db.select().from(connections)
    .where(and(eq(connections.graphId, v.graphId), eq(connections.userId, v.id), eq(connections.connector, MAC_CONNECTOR))).limit(1);
  return row ?? null;
}

function configOf(row: ConnectionRow): MacConfig {
  const r = macConfig.safeParse(row.config ?? {});
  return r.success ? r.data : macConfig.parse({});
}

async function knownPeople(v: Viewer): Promise<ImportKnown[]> {
  const people = await gbrain.listNodes(v, { type: "person", limit: 500 }).catch(() => []);
  return people.map((p) => ({
    id: p.id, type: p.type, kind: p.kind ?? null, label: p.label, aliases: p.aliases, startAt: p.startAt?.toISOString() ?? null, props: p.props ?? {},
  }));
}

function cursorsOf(state: ConnectionState) {
  return {
    messages: messagesCursor(state.streams?.messages?.cursor),
    notes: notesCursor(state.streams?.notes?.cursor),
    generations: { messages: state.streams?.messages?.resets ?? 0, notes: state.streams?.notes?.resets ?? 0 },
  };
}

/* ── The page ─────────────────────────────────────────────────────────────────────────────────────────── */

export type MacStatus = {
  connection: ConnectionDTO | null;
  pairing: { expiresAt: string } | null;
  helper: { device: string | null; pairedAt: string; lastSeenAt: string | null } | null;
  choices: { visibility: MacConfig["visibility"]; messages: MacConfig["messages"]; notes: MacConfig["notes"] };
  catalog: {
    at: string | null;
    chats: { id: string; name: string | null; participants: { handle: string; name: string | null }[]; count: number; lastAt: string | null; known: boolean }[];
    folders: { name: string; count: number }[];
    canRead: { messages?: boolean; notes?: boolean } | null;
  };
  /** How many conversations "people in this graph" covers right now. */
  knownCount: number;
  lastSend: MacConfig["lastSend"] | null;
  sent: { messagesUpTo: number | null; conversations: number; notesUpTo: string | null };
};

export async function macStatus(v: Viewer): Promise<MacStatus> {
  const row = await ownMac(v);
  const cfg = row ? configOf(row) : macConfig.parse({});
  const people = cfg.catalog?.chats.length ? await knownPeople(v) : [];
  const chats = (cfg.catalog?.chats ?? []).map((c) => ({
    id: c.id, name: c.name ?? null, participants: c.participants.map((p) => ({ handle: p.handle, name: p.name ?? null })),
    count: c.count, lastAt: c.lastAt ?? null, known: chatHasKnownPerson(c, people),
  }));
  const cur = cursorsOf(readState(row?.state));
  const live = cfg.pairing && Date.parse(cfg.pairing.expiresAt) > Date.now() ? { expiresAt: cfg.pairing.expiresAt } : null;
  return {
    connection: row ? (await getConnection(v, row.id)).connection : null,
    pairing: live,
    helper: cfg.helper ? { device: cfg.helper.device ?? null, pairedAt: cfg.helper.pairedAt, lastSeenAt: cfg.helper.lastSeenAt ?? null } : null,
    choices: { visibility: cfg.visibility, messages: cfg.messages, notes: cfg.notes },
    catalog: { at: cfg.catalog?.at ?? null, chats, folders: cfg.catalog?.folders ?? [], canRead: cfg.catalog?.canRead ?? null },
    knownCount: chats.filter((c) => c.known).length,
    lastSend: cfg.lastSend ?? null,
    sent: { messagesUpTo: cur.messages.rowId, conversations: cur.messages.sentChats.length, notesUpTo: cur.notes.updatedAt },
  };
}

/** A fresh one-time code for this person's Mac connection in this graph (made now if there is none). */
export async function startMacPairing(v: Viewer, input: { visibility?: MacConfig["visibility"] } = {}): Promise<{ code: string; expiresAt: string; connectionId: string }> {
  assertMayConnect(v);
  const code = newPairingCode();
  const expiresAt = new Date(Date.now() + PAIRING_MINUTES * 60_000).toISOString();
  const pairing = { hash: pairingHash(code), expiresAt };
  const existing = await ownMac(v);
  if (existing) {
    const merged = macConfig.parse({ ...configOf(existing), pairing, ...(input.visibility ? { visibility: input.visibility } : {}) });
    await db.update(connections).set({ config: merged, updatedAt: new Date() }).where(eq(connections.id, existing.id));
    void audit(v, "connections.mac.pairing", { type: "connection", id: existing.id }, {}).catch(() => {});
    return { code, expiresAt, connectionId: existing.id };
  }
  const id = crypto.randomUUID();
  const config = macConfig.parse({ visibility: input.visibility ?? "private", pairing });
  await db.insert(connections).values({
    id, graphId: v.graphId, userId: v.id, connector: MAC_CONNECTOR, label: "My Graph for Mac", config, secrets: encryptSecrets({}, id), state: {},
    // Nothing to fetch on a schedule: the helper sends. nextRunAt stays empty so the scheduler leaves it alone.
    status: "needs_you", statusDetail: "macAwaitingHelper|Waiting for the helper on your Mac to pair.", everyMinutes: 7 * 24 * 60, nextRunAt: null,
  });
  void audit(v, "connections.create", { type: "connection", id }, { connector: MAC_CONNECTOR }).catch(() => {});
  return { code, expiresAt, connectionId: id };
}

export type MacChoicesPatch = {
  visibility?: MacConfig["visibility"];
  messages?: { enabled?: boolean; scope?: "chosen" | "known"; chats?: string[]; since?: Since };
  notes?: { enabled?: boolean; folders?: string[] | null };
  /** Forget what was sent, so the next run sends everything chosen again (the importers skip what they have). */
  resend?: "messages" | "notes" | "both";
  /** Sign the helper out: its token stops working at once. */
  signOutHelper?: boolean;
};

export async function updateMacChoices(v: Viewer, patch: MacChoicesPatch): Promise<MacStatus> {
  assertMayConnect(v);
  const row = await ownMac(v);
  if (!row) throw new ConnectionError(404, "Connect your Mac first.");
  const cfg = configOf(row);
  const next = macConfig.parse({
    ...cfg,
    ...(patch.visibility ? { visibility: patch.visibility } : {}),
    messages: { ...cfg.messages, ...(patch.messages ?? {}) },
    notes: { ...cfg.notes, ...(patch.notes ?? {}) },
    ...(patch.signOutHelper ? { helper: null } : {}),
  });
  await db.transaction(async (tx) => {
    const [locked] = await tx.select({ state: connections.state }).from(connections).where(eq(connections.id, row.id)).for("update");
    let state = readState(locked?.state);
    if (patch.resend === "messages" || patch.resend === "both") state = resetStream(state, "messages");
    if (patch.resend === "notes" || patch.resend === "both") state = resetStream(state, "notes");
    await tx.update(connections).set({ config: next, state: state as Record<string, unknown>, updatedAt: new Date() }).where(eq(connections.id, row.id));
  });
  void audit(v, patch.signOutHelper ? "connections.mac.signOutHelper" : "connections.update", { type: "connection", id: row.id }, {
    fields: Object.keys(patch), messages: next.messages.enabled, notes: next.notes.enabled, scope: next.messages.scope, chats: next.messages.chats.length,
  }).catch(() => {});
  return macStatus(v);
}

/* ── The helper ───────────────────────────────────────────────────────────────────────────────────────── */

/** The helper hands in the pairing code and gets its token, once. No session: the code is the proof. */
export async function acceptPairing(input: { pairingCode: string; device?: string }, ip: string): Promise<{ token: string; connectionId: string; label: string }> {
  const ipKey = `mac-pair|${ip}`;
  for (const [lim, key] of [[pairPerAddress, ipKey], [pairOverall, "mac-pair|all"]] as const) {
    const c = lim.check(key);
    if (!c.allowed) throw new ConnectionError(429, `Too many tries. Wait ${Math.ceil(c.retryAfterSec / 60)} minutes and make a new pairing code.`);
  }
  const hash = pairingHash(input.pairingCode);
  const [row] = await db.select().from(connections)
    .where(and(eq(connections.connector, MAC_CONNECTOR), sql`${connections.config}->'pairing'->>'hash' = ${hash}`)).limit(1);
  const cfg = row ? configOf(row) : null;
  if (!row || !cfg?.pairing || Date.parse(cfg.pairing.expiresAt) <= Date.now()) {
    pairPerAddress.fail(ipKey);
    pairOverall.fail("mac-pair|all");
    throw new ConnectionError(400, "That pairing code isn't valid or has run out. Make a new one in My Graph (Connections, My Graph for Mac).", "macBadCode");
  }
  const v = await viewerFor(row.userId, row.graphId);
  if (!v || v.role === "guest" || !scopeOf(v).canWrite) throw new ConnectionError(403, "The person who made this code can no longer add to that graph.");

  const token = newHelperToken();
  const now = new Date().toISOString();
  const device = cleanDevice(input.device);
  const config = macConfig.parse({ ...cfg, pairing: null, helper: { tokenHash: tokenHash(token), pairedAt: now, device, lastSeenAt: now } });
  const label = device ? `My Graph for Mac: ${device}` : row.label;
  // Spend the code in the same statement that stores the token's hash (a second hand-in finds nothing).
  const updated = await db.update(connections).set({ config, label, status: "ok", statusDetail: null, updatedAt: new Date() })
    .where(and(eq(connections.id, row.id), sql`${connections.config}->'pairing'->>'hash' = ${hash}`)).returning({ id: connections.id });
  if (!updated.length) throw new ConnectionError(400, "That pairing code was just used. Make a new one in My Graph.", "macBadCode");
  pairPerAddress.reset(ipKey);
  void audit(v, "connections.mac.paired", { type: "connection", id: row.id }, { device }).catch(() => {});
  return { token, connectionId: row.id, label };
}

export type HelperAuth = { v: Viewer; row: ConnectionRow; cfg: MacConfig };

/** The helper's bearer token → the connection and the person, re-checked on every call. Throws ConnectionError. */
export async function helperAuth(req: Request, ip: string): Promise<HelperAuth> {
  const key = `mac-token|${ip}`;
  const c = badTokens.check(key);
  if (!c.allowed) throw new ConnectionError(429, "Too many tries with a wrong key. Wait a while and try again.");
  const token = bearerToken(req.headers.get("authorization"));
  const [row] = token
    ? await db.select().from(connections)
      .where(and(eq(connections.connector, MAC_CONNECTOR), sql`${connections.config}->'helper'->>'tokenHash' = ${tokenHash(token)}`)).limit(1)
    : [];
  if (!row) {
    badTokens.fail(key);
    throw new ConnectionError(401, "This helper isn't paired (or was signed out). Make a new pairing code in My Graph and run the helper with it.", "macUnpaired");
  }
  const v = await viewerFor(row.userId, row.graphId);
  if (!v) throw new ConnectionError(403, "You're no longer a member of the graph this Mac was connected to.", "notMember");
  if (v.role === "guest" || !scopeOf(v).canWrite) throw new ConnectionError(403, "You can only look at that graph now, so nothing can be added to it.", "readOnly");
  if (row.status === "paused") throw new ConnectionError(409, "This connection is paused in My Graph. Resume it there first.", "macPaused");
  return { v, row, cfg: configOf(row) };
}

export async function settingsFor(a: HelperAuth): Promise<HelperSettings> {
  const needPeople = a.cfg.messages.enabled && a.cfg.messages.scope === "known";
  const people = needPeople ? await knownPeople(a.v) : [];
  const cur = cursorsOf(readState(a.row.state));
  return helperSettings({ connectionId: a.row.id, label: a.row.label, config: a.cfg, people, ...cur, now: new Date() });
}

/** The helper reports which conversations and folders it can see (no messages, no notes) and gets its settings. */
export async function saveCatalog(a: HelperAuth, body: CatalogBody): Promise<HelperSettings> {
  const now = new Date().toISOString();
  const device = cleanDevice(body.device) ?? a.cfg.helper?.device ?? null;
  const cfg = macConfig.parse({
    ...a.cfg,
    catalog: { at: now, chats: body.chats, folders: body.folders, ...(body.canRead ? { canRead: body.canRead } : {}) },
    ...(a.cfg.helper ? { helper: { ...a.cfg.helper, device, lastSeenAt: now } } : {}),
  });
  await db.update(connections).set({ config: cfg, updatedAt: new Date() }).where(eq(connections.id, a.row.id));
  return settingsFor({ ...a, cfg });
}

export type BatchResult = { sourceId: string | null; duplicate: boolean; kept: number; dropped: number };

/**
 * One batch from the helper: keep only what the person allowed, store it as a source of the importer (the importer
 * proposes what it adds), move the cursor, and record it on the connection's run for this helper run.
 */
export async function importBatch(a: HelperAuth, importer: "imessage" | "apple_notes", env: BatchEnvelope): Promise<BatchResult> {
  const { v, row, cfg } = a;
  const device = cleanDevice(env.device) ?? cfg.helper?.device ?? null;
  let result: BatchResult = { sourceId: null, duplicate: false, kept: 0, dropped: 0 };
  let counts: { messages?: number; chats?: number; notes?: number } = {};

  if (importer === "imessage") {
    if (!cfg.messages.enabled) throw new ConnectionError(409, "Sending Messages is turned off in My Graph.", "macMessagesOff");
    const parsed = imessagePayload.safeParse(env.data);
    if (!parsed.success) throw new ConnectionError(400, parsed.error.issues[0]?.message ?? "That batch isn't in the expected shape.");
    const allowed = allowedChats(cfg, cfg.messages.scope === "known" ? await knownPeople(v) : []);
    const { payload, dropped } = filterChats(parsed.data, allowed);
    const messages = payload.chats.reduce((n, c) => n + c.messages.length, 0);
    counts = { messages, chats: payload.chats.filter((c) => c.messages.length).length };
    result = { ...result, kept: messages, dropped };
    if (messages > 0) {
      const r = await store(v, importer, payload, { row, cfg, batch: env.batch, title: batchTitle(importer, counts, device), sensitive: true });
      result = { ...result, ...r };
    }
    await moveCursor(row.id, "messages", (s) => nextMessagesCursor(messagesCursor(s), env, allowed));
  } else {
    if (!cfg.notes.enabled) throw new ConnectionError(409, "Sending Notes is turned off in My Graph.", "macNotesOff");
    const parsed = appleNotesPayload.safeParse(env.data);
    if (!parsed.success) throw new ConnectionError(400, parsed.error.issues[0]?.message ?? "That batch isn't in the expected shape.");
    const { payload, dropped } = filterNotes(parsed.data, cfg.notes.folders);
    counts = { notes: payload.notes.length };
    result = { ...result, kept: payload.notes.length, dropped };
    if (payload.notes.length > 0) {
      const r = await store(v, importer, payload, { row, cfg, batch: env.batch, title: batchTitle(importer, counts, device), sensitive: false });
      result = { ...result, ...r };
    }
    await moveCursor(row.id, "notes", (s) => nextNotesCursor(notesCursor(s), env));
  }

  await recordRun(row, env.runId, importer === "imessage" ? "messages" : "notes", result, counts, device);
  return result;
}

async function store(v: Viewer, importer: "imessage" | "apple_notes", payload: unknown, o: { row: ConnectionRow; cfg: MacConfig; batch: string; title: string; sensitive: boolean }) {
  try {
    const r = await importPayload(v, importer, {
      bytes: Buffer.from(JSON.stringify(payload)), title: o.title, connectionId: o.row.id, externalId: `${importer}:${o.batch}`,
      visibility: o.cfg.visibility, sensitive: o.sensitive,
    });
    return { sourceId: r.sourceId, duplicate: r.duplicate };
  } catch (e) {
    if (e instanceof IngestError) throw new ConnectionError(e.status === 404 ? 503 : e.status, e.status === 404 ? "My Graph can't read this kind of batch yet. Try again later." : e.message);
    throw e;
  }
}

async function moveCursor(id: string, stream: "messages" | "notes", next: (prev: unknown) => unknown): Promise<void> {
  await db.transaction(async (tx) => {
    const [locked] = await tx.select({ state: connections.state }).from(connections).where(eq(connections.id, id)).for("update");
    if (!locked) throw new ConnectionError(410, "This connection was disconnected.", "macUnpaired");
    const state = readState(locked.state);
    const updated = withCursor(state, stream, next(state.streams?.[stream]?.cursor));
    await tx.update(connections).set({ state: { ...(locked.state ?? {}), ...updated } as Record<string, unknown> }).where(eq(connections.id, id));
  });
}

/** One connection run per helper run (its batches add up), plus the "last send" shown on the page. */
async function recordRun(row: ConnectionRow, runId: string, stream: "messages" | "notes", r: BatchResult, counts: { messages?: number; chats?: number; notes?: number }, device: string | null) {
  const now = new Date();
  // Nothing new (the helper's "still here" batch): only note that it was heard from; no run, no new "last send".
  if (!r.kept && !r.dropped) {
    await db.transaction(async (tx) => {
      const [locked] = await tx.select({ config: connections.config }).from(connections).where(eq(connections.id, row.id)).for("update");
      if (!locked) return;
      const cfg = configOf({ ...row, config: locked.config });
      const next = { ...(locked.config ?? {}), ...(cfg.helper ? { helper: { ...cfg.helper, lastSeenAt: now.toISOString(), ...(device ? { device } : {}) } } : {}) };
      await tx.update(connections).set({
        config: next, lastRunAt: now, lastOkAt: now, updatedAt: now,
        status: sql`case when ${connections.status} = 'paused' then 'paused' else 'ok' end`, statusDetail: null,
      }).where(eq(connections.id, row.id));
    });
    return;
  }
  const added = r.sourceId && !r.duplicate ? 1 : 0;
  const [prev] = await db.select({ counts: connectionRuns.counts }).from(connectionRuns)
    .where(and(eq(connectionRuns.id, runId), eq(connectionRuns.connectionId, row.id))).limit(1).catch(() => []);
  const c = (prev?.counts ?? { trigger: "helper", streams: {}, log: [] }) as { trigger?: string; streams?: Record<string, Record<string, number>>; log?: string[] };
  const s = { ...(c.streams?.[stream] ?? {}) };
  s.fetched = (s.fetched ?? 0) + r.kept;
  s.added = (s.added ?? 0) + added;
  if (r.duplicate) s.unchanged = (s.unchanged ?? 0) + 1;
  if (r.dropped) s.skipped = (s.skipped ?? 0) + r.dropped;
  const log = [...(c.log ?? [])];
  if (log.length < 50 && r.kept) log.push(stream === "messages" ? `Received ${r.kept} messages from ${device ?? "the Mac"}.` : `Received ${r.kept} notes from ${device ?? "the Mac"}.`);
  const nextCounts = { ...c, trigger: "helper", streams: { ...(c.streams ?? {}), [stream]: s }, log };
  if (prev) {
    await db.update(connectionRuns).set({ counts: nextCounts, status: "done", finishedAt: now }).where(and(eq(connectionRuns.id, runId), eq(connectionRuns.connectionId, row.id))).catch(() => {});
  } else {
    await db.insert(connectionRuns).values({ id: runId, connectionId: row.id, graphId: row.graphId, status: "done", startedAt: now, finishedAt: now, counts: nextCounts }).catch(() => {});
  }
  await db.transaction(async (tx) => {
    const [locked] = await tx.select({ config: connections.config }).from(connections).where(eq(connections.id, row.id)).for("update");
    if (!locked) return;
    const cfg = configOf({ ...row, config: locked.config });
    const sameRun = cfg.lastSend?.runId === runId;
    const base = sameRun ? cfg.lastSend! : { at: now.toISOString() };
    const lastSend = {
      ...base, at: now.toISOString(), runId,
      ...(counts.messages !== undefined ? { messages: (sameRun ? base.messages ?? 0 : 0) + counts.messages, chats: Math.max(sameRun ? base.chats ?? 0 : 0, counts.chats ?? 0) } : {}),
      ...(counts.notes !== undefined ? { notes: (sameRun ? base.notes ?? 0 : 0) + counts.notes } : {}),
      sourceIds: [...new Set([...(sameRun ? base.sourceIds ?? [] : []), ...(r.sourceId ? [r.sourceId] : [])])].slice(-50),
    };
    const next = { ...(locked.config ?? {}), lastSend, ...(cfg.helper ? { helper: { ...cfg.helper, lastSeenAt: now.toISOString(), ...(device ? { device } : {}) } } : {}) };
    await tx.update(connections).set({
      config: next, lastRunAt: now, lastOkAt: now, updatedAt: now,
      status: sql`case when ${connections.status} = 'paused' then 'paused' else 'ok' end`, statusDetail: null,
    }).where(eq(connections.id, row.id));
  });
}
