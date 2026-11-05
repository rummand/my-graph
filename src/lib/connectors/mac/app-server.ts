/**
 * My Graph for Mac, the menu bar app: server side (server-only). The contract is docs/mac-app-api.md.
 *
 *   signInDevice   POST /device with the person's session: makes (or reuses) their Mac connection in the current
 *                  graph and hands the app a token of the same kind the Node helper gets from pairing (only its hash
 *                  is kept), so every bearer route under /api/connections/mac accepts it. Pairing codes keep working.
 *   settings       the source switches (all off until chosen), write-back and folder labels.
 *   importAppBatch the import door for contacts, photos, calendar, reminders and calls: refused (409) unless the
 *                  source is on; what was sent before in the same form is dropped; the rest is kept as a library
 *                  source and read by its importer, which proposes a change set. Agents propose, humans decide.
 *   uploadFile     the file door: a file from a chosen folder (or a Voice Memo) is kept like a library upload, as the
 *                  person, in the connection's graph; the same file id with new bytes is the next version.
 *   outbox / ack   what the app may write on the Mac: only the person's own reminders and events they can read,
 *                  when they turned write-back on. The one write the Mac makes back is ticking a reminder done.
 *   status         for the menu bar badge: proposals waiting, the last imports.
 */
import { and, desc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { connections, reminders, sources } from "@/db/schema";
import { audit, type Viewer } from "@/lib/auth";
import { waitingCount } from "@/lib/changes/store";
import * as gbrain from "@/lib/gbrain";
import { callsPayload, calendarPayload, contactsPayload, photosPayload, remindersPayload, type CalendarPayload, type CallsPayload, type RemindersPayload } from "@/lib/importers/schemas";
import { inCalendarWindow } from "@/lib/importers/calendar";
import { reminderKey } from "@/lib/importers/reminders";
import { detectFileType, MAX_UPLOAD_BYTES } from "@/lib/ingest/mime";
import { docKeyOf, nameKeyOf } from "@/lib/ingest/revisions";
import { appendRevision } from "@/lib/ingest/revisions-store";
import { importerById } from "@/lib/importers/registry";
import { enqueueSourceRead } from "@/lib/jobs/queue";
import { limiter } from "@/lib/security";
import { putFile, sha256Hex } from "@/lib/storage";
import { encryptSecrets } from "../crypto";
import { readState } from "../state";
import { ConnectionError } from "../store";
import {
  APP_IMPORTERS, MAC_REMINDER_MARK, OUTBOX_RULES, applyAppSettings, callsCursor, decideUpload, fileNameOf, filterUnsent, newerCalls,
  outboxLedger, outboxPage, parseSince, reconcileOutbox, sentLedger, sourceOffError, sourceOn, sourcesOf,
  type AppImporter, type AppSettingsBody, type MacSource, type OutboxCurrent, type OutboxItem, type UploadFields,
} from "./app";
import { MAC_CONNECTOR, cleanDevice, macConfig, newHelperToken, tokenHash, type BatchEnvelope, type HelperSettings, type MacConfig } from "./config";
import { assertMayConnect, configOf, moveCursor, ownMac, recordRun, settingsFor, store, type BatchResult, type HelperAuth } from "./server";

const DAY = 86_400_000;

function refuseOff(source: MacSource): never {
  const e = sourceOffError(source);
  throw new ConnectionError(e.status, e.message, e.code);
}

const graphOf = (v: Viewer) => ({ id: v.graphId, name: v.graphName, kind: v.graphKind });

/* ── Device sign-in ───────────────────────────────────────────────────────────────────────────────────── */

export async function signInDevice(v: Viewer, input: { deviceName: string; appVersion: string }): Promise<{ connectionId: string; token: string; graph: { id: string; name: string; kind: string } }> {
  assertMayConnect(v);
  const rate = await limiter().hit({ bucket: "mac.device", limit: 10, windowMs: 15 * 60_000 }, v.id);
  if (!rate.allowed) throw Object.assign(new ConnectionError(429, "Too many sign-ins from the Mac app. Wait a few minutes and try again."), { retryAfterSec: rate.retryAfterSec });
  const token = newHelperToken();
  const now = new Date().toISOString();
  const device = cleanDevice(input.deviceName);
  const helper = { tokenHash: tokenHash(token), pairedAt: now, device, lastSeenAt: now, kind: "app" as const, appVersion: input.appVersion.slice(0, 40) };
  const label = device ? `My Graph for Mac: ${device}` : "My Graph for Mac";
  const existing = await ownMac(v);
  if (existing) {
    const config = macConfig.parse({ ...configOf(existing), pairing: null, helper });
    await db.update(connections).set({
      config, label, updatedAt: new Date(),
      status: sql`case when ${connections.status} = 'paused' then 'paused' else 'ok' end`, statusDetail: null,
    }).where(eq(connections.id, existing.id));
    void audit(v, "connections.mac.deviceSignIn", { type: "connection", id: existing.id }, { device, appVersion: helper.appVersion, replaced: !!configOf(existing).helper }).catch(() => {});
    return { connectionId: existing.id, token, graph: graphOf(v) };
  }
  const id = crypto.randomUUID();
  await db.insert(connections).values({
    id, graphId: v.graphId, userId: v.id, connector: MAC_CONNECTOR, label, config: macConfig.parse({ visibility: "private", helper }),
    secrets: encryptSecrets({}, id), state: {}, status: "ok", statusDetail: null, everyMinutes: 7 * 24 * 60, nextRunAt: null,
  });
  void audit(v, "connections.create", { type: "connection", id }, { connector: MAC_CONNECTOR, via: "device", device, appVersion: helper.appVersion }).catch(() => {});
  return { connectionId: id, token, graph: graphOf(v) };
}

/* ── Settings ─────────────────────────────────────────────────────────────────────────────────────────── */

export type AppSettings = HelperSettings & {
  sources: Record<MacSource, boolean>;
  writeBack: MacConfig["writeBack"];
  folders: string[];
  graph: { id: string; name: string; kind: string };
  cursors: { calls: string | null };
  uploadMaxBytes: number;
};

export async function appSettingsFor(a: HelperAuth): Promise<AppSettings> {
  const base = await settingsFor(a);
  const state = readState(a.row.state);
  return {
    ...base,
    sources: sourcesOf(a.cfg),
    writeBack: a.cfg.writeBack,
    folders: a.cfg.folders,
    graph: graphOf(a.v),
    cursors: { calls: callsCursor(state.streams?.calls?.cursor).lastAt },
    uploadMaxBytes: MAX_UPLOAD_BYTES,
  };
}

export async function updateAppSettings(a: HelperAuth, body: AppSettingsBody): Promise<AppSettings> {
  const next = await db.transaction(async (tx) => {
    const [locked] = await tx.select({ config: connections.config }).from(connections).where(eq(connections.id, a.row.id)).for("update");
    if (!locked) throw new ConnectionError(410, "This connection was disconnected.", "macUnpaired");
    const cfg = macConfig.parse(applyAppSettings(configOf({ ...a.row, config: locked.config }), body));
    await tx.update(connections).set({ config: cfg, updatedAt: new Date() }).where(eq(connections.id, a.row.id));
    return cfg;
  });
  void audit(a.v, "connections.update", { type: "connection", id: a.row.id }, {
    via: "mac-app", sources: sourcesOf(next), writeBack: next.writeBack, folders: next.folders.length,
  }).catch(() => {});
  return appSettingsFor({ ...a, cfg: next });
}

/* ── The import door (contacts, photos, calendar, reminders, calls) ───────────────────────────────────── */

const SCHEMAS = { contacts: contactsPayload, photos: photosPayload, calendar: calendarPayload, reminders: remindersPayload, calls: callsPayload } as const;
type NewImporter = keyof typeof SCHEMAS;

export function isNewImporter(id: AppImporter): id is NewImporter {
  return id in SCHEMAS;
}

const TITLES: Record<NewImporter, (n: number, from: string) => string> = {
  contacts: (n, from) => `Contacts${from}: ${n} ${n === 1 ? "card" : "cards"}`,
  photos: (n, from) => `Photos${from}: ${n} ${n === 1 ? "photo" : "photos"}`,
  calendar: (n, from) => `Calendar${from}: ${n} ${n === 1 ? "event" : "events"}`,
  reminders: (n, from) => `Reminders${from}: ${n} ${n === 1 ? "reminder" : "reminders"}`,
  calls: (n, from) => `Calls${from}: ${n} ${n === 1 ? "call" : "calls"}`,
};

/** Reminder keys (title + due day) the person already has in this graph, so the Mac's copy isn't proposed again. */
async function ownReminderKeys(v: Viewer): Promise<Set<string>> {
  const rows = await db.select({ title: reminders.title, dueAt: reminders.dueAt }).from(reminders)
    .where(and(eq(reminders.graphId, v.graphId), eq(reminders.ownerId, v.id), gte(reminders.dueAt, new Date(Date.now() - 400 * DAY))))
    .orderBy(desc(reminders.dueAt)).limit(5000);
  return new Set(rows.map((r) => reminderKey(r.title, r.dueAt.toISOString())));
}

export async function importAppBatch(a: HelperAuth, importer: NewImporter, env: BatchEnvelope): Promise<BatchResult & { unchanged: number }> {
  const { v, row, cfg } = a;
  const source = APP_IMPORTERS[importer];
  if (!sourceOn(cfg, source)) refuseOff(source);
  const parsed = SCHEMAS[importer].safeParse(env.data);
  if (!parsed.success) throw new ConnectionError(400, parsed.error.issues[0]?.message ?? "That batch isn't in the expected shape.");
  const device = cleanDevice(env.device) ?? cfg.helper?.device ?? null;
  const state = readState(row.state);

  // What is new or changed since the last send; the rest is dropped before anything is stored.
  let payload: unknown;
  let kept = 0, unchanged = 0, dropped = 0;
  let nextCursor: unknown;
  if (importer === "calls") {
    const data = parsed.data as CallsPayload;
    const cur = callsCursor(state.streams?.calls?.cursor);
    const r = newerCalls(data.calls, cur.lastAt);
    unchanged = data.calls.length - r.fresh.length;
    payload = { calls: r.fresh };
    kept = r.fresh.length;
    nextCursor = { lastAt: r.next };
  } else {
    const sent = sentLedger(state.streams?.[importer]?.cursor);
    const key = importer === "calendar" ? "events" : importer;
    let items = (parsed.data as Record<string, { id: string }[]>)[key];
    const before = items.length;
    if (importer === "reminders") {
      // Finished ones are never stored; ones the person already has in My Graph (or that My Graph wrote back) neither.
      const have = await ownReminderKeys(v);
      const list = items as unknown as RemindersPayload["reminders"];
      items = list.filter((r) => !r.done && (!r.due || !have.has(reminderKey(r.title, r.due))));
    } else if (importer === "calendar") {
      // Outside the window (30 days back, 120 ahead) nothing is stored.
      const now = new Date();
      items = (items as unknown as CalendarPayload["events"]).filter((e) => inCalendarWindow(e, now));
    }
    dropped = before - items.length;
    const r = filterUnsent(items, (it) => it.id, sent);
    unchanged = r.unchanged;
    payload = { [key]: r.fresh };
    kept = r.fresh.length;
    nextCursor = { sent: r.next };
  }

  let result: BatchResult = { sourceId: null, duplicate: false, kept, dropped: dropped };
  if (kept > 0) {
    const from = device ? ` from ${device}` : " from your Mac";
    const r = await store(v, importer, payload, {
      row, cfg, batch: env.batch, title: TITLES[importer](kept, from), sensitive: importer === "calls",
    });
    result = { ...result, ...r };
  }
  // The cursor moves only after the batch is stored (a failure above leaves it, and the Mac sends it again).
  await moveCursor(row.id, importer, () => nextCursor);
  await recordRun(row, env.runId, importer, result, { other: kept }, device);
  return { ...result, unchanged };
}

/* ── The file door ────────────────────────────────────────────────────────────────────────────────────── */

export type UploadResult = {
  sourceId: string; outcome: "new" | "version" | "unchanged" | "duplicate"; revision: number; title: string; sameAs?: string;
};

export async function uploadFile(a: HelperAuth, file: File, f: UploadFields): Promise<UploadResult> {
  const { v, row, cfg } = a;
  if (!sourceOn(cfg, f.source)) refuseOff(f.source);
  if (f.source === "files" && !cfg.folders.includes(f.folderLabel)) {
    throw new ConnectionError(409, `“${f.folderLabel}” isn't one of the folders chosen for My Graph. Choose it in the app's settings first.`, "macFolderNotChosen");
  }
  const rate = await limiter().hit({ bucket: "mac.upload", limit: 300, windowMs: 10 * 60_000 }, v.id);
  if (!rate.allowed) throw Object.assign(new ConnectionError(429, "Too many files at once. The app waits and tries again."), { retryAfterSec: rate.retryAfterSec });

  const name = fileNameOf(f.relPath);
  if (file.size === 0) throw new ConnectionError(400, `“${name}” is empty.`);
  if (file.size > MAX_UPLOAD_BYTES) throw new ConnectionError(413, `“${name}” is ${(file.size / 1024 / 1024).toFixed(0)} MB. The limit is 50 MB per file.`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = detectFileType(name, file.type, bytes.subarray(0, 8192));
  if (!type.ok) throw new ConnectionError(415, type.reason);
  if (f.source === "voiceMemos" && type.kind !== "audio") throw new ConnectionError(415, `“${name}” isn't a recording. Voice Memos sends audio only.`);
  const importer = importerById(type.importer);
  if (importer?.graphKinds?.length && !importer.graphKinds.includes(v.graphKind)) {
    throw new ConnectionError(415, `“${name}” is ${importer.label}, which can only be imported into a ${importer.graphKinds.join(" or ")} graph.`);
  }

  const sha256 = sha256Hex(bytes);
  const externalId = `file:${f.fileId}`;
  const mine = and(eq(sources.graphId, v.graphId), eq(sources.ownerId, v.id));
  const [prev] = await db.select().from(sources)
    .where(and(mine, eq(sources.connectionId, row.id), eq(sources.externalId, externalId), isNull(sources.supersededAt)))
    .orderBy(desc(sources.revision), desc(sources.createdAt)).limit(1);
  const [same] = prev ? [] : await db.select({ id: sources.id, title: sources.title }).from(sources).where(and(mine, eq(sources.sha256, sha256))).limit(1);
  const decision = decideUpload({ sha256, prev: prev ? { id: prev.id, sha256: prev.sha256 } : null, sameBytes: same ?? null });

  if (decision.action === "unchanged") return { sourceId: decision.sourceId, outcome: "unchanged", revision: prev!.revision, title: prev!.title };
  if (decision.action === "duplicate") return { sourceId: decision.of.id, outcome: "duplicate", revision: 1, title: decision.of.title, sameAs: decision.of.title };

  const docKey = await docKeyOf({ bytes, kind: type.kind, ext: type.ext });
  const stored = await putFile(bytes);
  const voice = f.source === "voiceMemos";
  const [created] = await db.insert(sources).values({
    householdId: v.graphHouseholdId,
    graphId: v.graphId,
    ownerId: v.id,
    kind: type.kind === "email" ? "email" : "upload",
    title: name,
    mime: type.mime,
    storageKey: stored.storageKey,
    sha256,
    size: stored.size,
    docKey,
    nameKey: nameKeyOf(name, type.kind),
    meta: {
      originalName: name, kind: type.kind, declaredMime: file.type || null, ...(importer ? { importer: importer.id } : {}),
      mac: { fileId: f.fileId, relPath: f.relPath, folderLabel: f.folderLabel, source: f.source, ...(f.modifiedAt ? { modifiedAt: f.modifiedAt } : {}), device: cfg.helper?.device ?? null },
      // The version is set here from the Mac's file id; the reading pipeline doesn't guess it again.
      revisionSettled: true,
      ...(prev ? { revisionOf: prev.id } : {}),
    },
    status: "pending",
    // Voice Memos are the person's own: private. Files take the connection's visibility.
    visibility: voice ? "private" : cfg.visibility,
    sensitive: !!importer?.sensitive,
    connectionId: row.id,
    externalId,
    fetchedAt: new Date(),
  }).returning({ id: sources.id });

  let revision = 1;
  if (decision.action === "version" && prev) {
    revision = (await appendRevision({ id: created.id, graphId: v.graphId, ownerId: v.id }, prev)).revision;
    await db.update(sources).set({ meta: sql`jsonb_set(${sources.meta}, '{revision}', to_jsonb(${revision}::int))` }).where(eq(sources.id, created.id));
  }
  void audit(v, "library.upload", { type: "source", id: created.id }, { via: "mac-app", source: f.source, mime: type.mime, size: stored.size, revision }).catch(() => {});
  await enqueueSourceRead(v.id, created.id, { fromFile: true, priority: 30 });
  return { sourceId: created.id, outcome: decision.action, revision, title: name };
}

/* ── Write-back outbox ────────────────────────────────────────────────────────────────────────────────── */

async function outboxCurrent(v: Viewer, cfg: MacConfig, origin: string, now: Date): Promise<OutboxCurrent[]> {
  const out: OutboxCurrent[] = [];
  if (cfg.writeBack.reminders) {
    // Only the person's own reminders in this graph: open ones, and ones finished in the last 30 days.
    const rows = await db.select({ id: reminders.id, title: reminders.title, detail: reminders.detail, dueAt: reminders.dueAt, done: reminders.done })
      .from(reminders)
      .where(and(eq(reminders.graphId, v.graphId), eq(reminders.ownerId, v.id),
        or(eq(reminders.done, false), gte(reminders.dueAt, new Date(now.getTime() - OUTBOX_RULES.doneReminderDays * DAY)))))
      .orderBy(reminders.dueAt).limit(1000);
    for (const r of rows) {
      if ((r.detail ?? "").includes(MAC_REMINDER_MARK)) continue; // came from the Mac's own Reminders
      out.push({ id: r.id, kind: "reminder", title: r.title, notes: r.detail, dueAt: r.dueAt.toISOString(), done: r.done, url: `${origin}/?reminder=${r.id}` });
    }
  }
  if (cfg.writeBack.events) {
    const { events } = await gbrain.timeline(v, { from: now, to: new Date(now.getTime() + OUTBOX_RULES.eventDays * DAY), limit: 1000 });
    for (const e of events) {
      if (e.type !== "event" || !e.startAt) continue;
      // Never health or other sensitive events, and never events that came from a Mac calendar (the Mac has them).
      if (e.sensitive || typeof e.props?.macEventId === "string") continue;
      out.push({
        id: e.id, kind: "event", title: e.label, notes: e.summary, startAt: e.startAt.toISOString(), endAt: e.endAt?.toISOString() ?? null,
        allDay: e.props?.allDay === true || e.timePrecision === "day", done: false, url: `${origin}/node/${e.id}`,
      });
    }
  }
  return out;
}

export async function outbox(a: HelperAuth, sinceRaw: string | null, origin: string): Promise<{ items: OutboxItem[]; cursor: string }> {
  const now = new Date();
  const current = await outboxCurrent(a.v, a.cfg, origin, now);
  return db.transaction(async (tx) => {
    const [locked] = await tx.select({ state: connections.state }).from(connections).where(eq(connections.id, a.row.id)).for("update");
    if (!locked) throw new ConnectionError(410, "This connection was disconnected.", "macUnpaired");
    const state = readState(locked.state);
    const prev = outboxLedger(state.streams?.outbox?.cursor);
    const { ledger, changed } = reconcileOutbox(prev, current, now);
    if (changed) {
      const streams = { ...(state.streams ?? {}), outbox: { ...(state.streams?.outbox ?? {}), cursor: ledger, updatedAt: now.toISOString() } };
      await tx.update(connections).set({ state: { ...(locked.state ?? {}), streams } as Record<string, unknown> }).where(eq(connections.id, a.row.id));
    }
    return outboxPage(ledger, current, parseSince(sinceRaw, ledger));
  });
}

/** The person ticked one of their reminders done on their Mac. Their own reminder in this graph only. */
export async function ackReminder(a: HelperAuth, id: string): Promise<{ id: string; done: true }> {
  if (!a.cfg.writeBack.reminders) throw new ConnectionError(409, "Reminders aren't shared with this Mac. Turn write-back for reminders on first.", "macWriteBackOff");
  const updated = await db.update(reminders).set({ done: true })
    .where(and(eq(reminders.id, id), eq(reminders.graphId, a.v.graphId), eq(reminders.ownerId, a.v.id))).returning({ id: reminders.id });
  if (!updated.length) throw new ConnectionError(404, "That reminder isn't one of yours in this graph.");
  void audit(a.v, "reminders.done", { type: "reminder", id }, { via: "mac-app", connectionId: a.row.id, device: a.cfg.helper?.device ?? null }).catch(() => {});
  return { id, done: true };
}

/* ── Status ───────────────────────────────────────────────────────────────────────────────────────────── */

export type AppStatus = {
  waiting: number;
  lastImports: { sourceId: string; title: string; kind: string; status: string; at: string }[];
  graph: { id: string; name: string; kind: string };
  connection: { id: string; status: string; lastRunAt: string | null };
};

export async function appStatus(a: HelperAuth): Promise<AppStatus> {
  const [waiting, recent] = await Promise.all([
    waitingCount(a.v).catch(() => 0),
    db.select({ id: sources.id, title: sources.title, meta: sources.meta, status: sources.status, createdAt: sources.createdAt, fetchedAt: sources.fetchedAt })
      .from(sources)
      .where(and(eq(sources.graphId, a.v.graphId), eq(sources.ownerId, a.v.id), eq(sources.connectionId, a.row.id), inArray(sources.status, ["pending", "processing", "ready", "failed"])))
      .orderBy(desc(sql`coalesce(${sources.fetchedAt}, ${sources.createdAt})`)).limit(10),
  ]);
  return {
    waiting,
    lastImports: recent.map((s) => {
      const m = (s.meta ?? {}) as Record<string, unknown>;
      const mac = m.mac as { source?: string } | undefined;
      return { sourceId: s.id, title: s.title, kind: typeof m.importer === "string" ? m.importer : mac?.source ?? "files", status: s.status, at: (s.fetchedAt ?? s.createdAt).toISOString() };
    }),
    graph: graphOf(a.v),
    connection: { id: a.row.id, status: a.row.status, lastRunAt: a.row.lastRunAt?.toISOString() ?? null },
  };
}

