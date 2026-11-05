/**
 * My Graph for Mac, the menu bar app (pure, no DB): which sources it may send, the switch each import needs, what
 * counts as "already sent", which upload is a new version of which file, and the write-back outbox (what changed since
 * the app last asked). The server side is app-server.ts; the contract the native app is built against is
 * docs/mac-app-api.md.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import type { MacConfig } from "./config";

/* ── Sources and switches ─────────────────────────────────────────────────────────────────────────────── */

export const MAC_SOURCES = ["messages", "notes", "contacts", "calendar", "reminders", "photos", "files", "voiceMemos", "calls"] as const;
export type MacSource = (typeof MAC_SOURCES)[number];

/** The importers the Mac's import door takes, and the switch each one needs. */
export const APP_IMPORTERS = {
  imessage: "messages",
  apple_notes: "notes",
  contacts: "contacts",
  photos: "photos",
  calendar: "calendar",
  reminders: "reminders",
  calls: "calls",
} as const satisfies Record<string, MacSource>;
export type AppImporter = keyof typeof APP_IMPORTERS;
export const APP_IMPORTER_IDS = Object.keys(APP_IMPORTERS) as [AppImporter, ...AppImporter[]];

export function sourcesOf(cfg: MacConfig): Record<MacSource, boolean> {
  return { messages: cfg.messages.enabled, notes: cfg.notes.enabled, ...cfg.sources };
}

export function sourceOn(cfg: MacConfig, source: MacSource): boolean {
  return sourcesOf(cfg)[source];
}

const SOURCE_NAMES: Record<MacSource, string> = {
  messages: "Messages", notes: "Notes", contacts: "Contacts", calendar: "Calendar", reminders: "Reminders",
  photos: "Photos", files: "Files", voiceMemos: "Voice Memos", calls: "Call history",
};

/** The refusal when a switch is off: 409 with a code the app can show in its own words. */
export function sourceOffError(source: MacSource): { status: 409; message: string; code: string } {
  return { status: 409, message: `Sending ${SOURCE_NAMES[source]} is turned off in My Graph. Turn it on in the app's settings first.`, code: `macSourceOff:${source}` };
}

/** PUT /api/connections/mac/settings: switches, write-back and folders (all optional; what is left out stays). */
export const appSettingsBody = z.object({
  sources: z.object(Object.fromEntries(MAC_SOURCES.map((s) => [s, z.boolean().optional()])) as Record<MacSource, z.ZodOptional<z.ZodBoolean>>).strict().optional(),
  writeBack: z.object({ reminders: z.boolean().optional(), events: z.boolean().optional() }).strict().optional(),
  folders: z.array(z.string().trim().min(1).max(300)).max(100).optional(),
}).strict().refine((b) => Object.keys(b).length > 0, "Nothing to change.");
export type AppSettingsBody = z.infer<typeof appSettingsBody>;

/** The config after the app's settings change (Messages and Notes keep their own place in the config). */
export function applyAppSettings(cfg: MacConfig, body: AppSettingsBody): MacConfig {
  const s = body.sources ?? {};
  const { messages, notes, ...rest } = s;
  const other = Object.fromEntries(Object.entries(rest).filter(([, v]) => typeof v === "boolean")) as Partial<MacConfig["sources"]>;
  return {
    ...cfg,
    messages: { ...cfg.messages, ...(typeof messages === "boolean" ? { enabled: messages } : {}) },
    notes: { ...cfg.notes, ...(typeof notes === "boolean" ? { enabled: notes } : {}) },
    sources: { ...cfg.sources, ...other },
    writeBack: { ...cfg.writeBack, ...Object.fromEntries(Object.entries(body.writeBack ?? {}).filter(([, v]) => typeof v === "boolean")) },
    folders: body.folders ? [...new Set(body.folders.map((f) => f.trim()).filter(Boolean))] : cfg.folders,
  };
}

/* ── "Already sent": the Mac sends its whole window each time; only what is new or changed goes on ─────── */

const h = (s: string, n: number) => createHash("sha256").update(s).digest("hex").slice(0, n);
export const SENT_CAP = 5000;

export type SentLedger = Record<string, string>;

export function sentLedger(raw: unknown): SentLedger {
  const c = raw && typeof raw === "object" ? (raw as { sent?: unknown }).sent : null;
  if (!c || typeof c !== "object" || Array.isArray(c)) return {};
  return Object.fromEntries(Object.entries(c as Record<string, unknown>).filter(([, v]) => typeof v === "string")) as SentLedger;
}

/** Items not sent before in this exact form; the ledger to save once they are stored (the newest SENT_CAP kept). */
export function filterUnsent<T>(items: T[], idOf: (t: T) => string, sent: SentLedger): { fresh: T[]; unchanged: number; next: SentLedger } {
  const next: SentLedger = { ...sent };
  const fresh: T[] = [];
  let unchanged = 0;
  for (const it of items) {
    const k = h(idOf(it), 16);
    const fp = h(JSON.stringify(it), 12);
    if (sent[k] === fp) { unchanged++; continue; }
    fresh.push(it);
    delete next[k];
    next[k] = fp;
  }
  const keys = Object.keys(next);
  if (keys.length > SENT_CAP) for (const k of keys.slice(0, keys.length - SENT_CAP)) delete next[k];
  return { fresh, unchanged, next };
}

/** Calls only grow: the newest call time sent so far. Calls before it are dropped (the same moment is kept). */
export function callsCursor(raw: unknown): { lastAt: string | null } {
  const c = raw && typeof raw === "object" ? (raw as { lastAt?: unknown }).lastAt : null;
  return { lastAt: typeof c === "string" && !Number.isNaN(Date.parse(c)) ? c : null };
}

export function newerCalls<T extends { at: string }>(calls: T[], lastAt: string | null): { fresh: T[]; next: string | null } {
  const cut = lastAt ? Date.parse(lastAt) : -Infinity;
  const fresh = calls.filter((c) => Date.parse(c.at) >= cut);
  const newest = fresh.reduce<number>((m, c) => Math.max(m, Date.parse(c.at)), cut);
  return { fresh, next: Number.isFinite(newest) ? new Date(newest).toISOString() : lastAt };
}

/* ── Files: the same file id with new bytes is the next version of that document ──────────────────────── */

export type UploadDecision =
  | { action: "unchanged"; sourceId: string }
  | { action: "version"; prevId: string }
  | { action: "duplicate"; of: { id: string; title: string } }
  | { action: "new" };

/**
 * prev: the newest version this Mac sent under the same file id; sameBytes: a file of this person in this graph with
 * exactly these bytes (any name), if any.
 */
export function decideUpload(input: { sha256: string; prev: { id: string; sha256: string | null } | null; sameBytes: { id: string; title: string } | null }): UploadDecision {
  if (input.prev) return input.prev.sha256 === input.sha256 ? { action: "unchanged", sourceId: input.prev.id } : { action: "version", prevId: input.prev.id };
  if (input.sameBytes) return { action: "duplicate", of: input.sameBytes };
  return { action: "new" };
}

export const FILE_ID = /^[A-Za-z0-9._:+/=-]{1,200}$/;

export const uploadFields = z.object({
  fileId: z.string().regex(FILE_ID, "fileId must be the Mac's stable id for the file (letters, digits and ._:+/=-, at most 200)."),
  relPath: z.string().trim().min(1).max(1000),
  modifiedAt: z.string().datetime({ offset: true }).optional(),
  folderLabel: z.string().trim().min(1).max(300),
  /** "files" (a chosen folder) or "voiceMemos" (Voice Memos recordings). */
  source: z.enum(["files", "voiceMemos"]).default("files"),
});
export type UploadFields = z.infer<typeof uploadFields>;

/** The file's name from its path relative to the chosen folder. */
export function fileNameOf(relPath: string): string {
  return (relPath.split(/[\\/]/).filter(Boolean).pop() ?? "Untitled").replace(/[\u0000-\u001f]/g, "").slice(0, 250) || "Untitled";
}

/* ── Write-back outbox ────────────────────────────────────────────────────────────────────────────────── */

export type OutboxKind = "reminder" | "event";

/** One thing the app may write on the Mac, as My Graph has it now. */
export type OutboxCurrent = {
  id: string; kind: OutboxKind; title: string; notes?: string | null; dueAt?: string | null; startAt?: string | null; endAt?: string | null;
  allDay?: boolean; done: boolean; url: string;
};

export type OutboxItem = Omit<OutboxCurrent, "notes" | "dueAt" | "startAt" | "endAt"> & {
  notes?: string; dueAt?: string; startAt?: string; endAt?: string; deleted: boolean; updatedAt: string;
};

type LedgerEntry = { fp: string; seq: number; at: string; kind: OutboxKind; title: string; url: string; when: string | null; done: boolean; deleted?: boolean };
export type OutboxLedger = { seq: number; items: Record<string, LedgerEntry> };

export const OUTBOX_RULES = { eventDays: 60, doneReminderDays: 30, tombstoneDays: 30 } as const;
const DAY = 86_400_000;

export function outboxLedger(raw: unknown): OutboxLedger {
  const r = raw && typeof raw === "object" ? (raw as Partial<OutboxLedger>) : {};
  return { seq: Number.isSafeInteger(r.seq) && (r.seq as number) >= 0 ? (r.seq as number) : 0, items: r.items && typeof r.items === "object" ? r.items : {} };
}

const keyOf = (i: { kind: OutboxKind; id: string }) => `${i.kind}:${i.id}`;
const fpOf = (i: OutboxCurrent) => h(JSON.stringify([i.title, i.notes ?? null, i.dueAt ?? null, i.startAt ?? null, i.endAt ?? null, !!i.allDay, i.done]), 16);

/** Did this item simply leave the window (an event that started, an old finished reminder)? Then it isn't "deleted". */
function agedOut(e: LedgerEntry, now: Date): boolean {
  if (!e.when) return false;
  const t = Date.parse(e.when);
  if (e.kind === "event") return t < now.getTime();
  return e.done && t < now.getTime() - OUTBOX_RULES.doneReminderDays * DAY;
}

/**
 * Bring the ledger up to date with what My Graph has now: a new or changed item gets the next sequence number, an
 * item gone (deleted, no longer visible, write-back turned off) becomes a tombstone (kept 30 days), an item that only
 * left the window is forgotten quietly. Returns the new ledger and whether it changed.
 */
export function reconcileOutbox(prev: OutboxLedger, current: OutboxCurrent[], now: Date): { ledger: OutboxLedger; changed: boolean } {
  let seq = prev.seq;
  const items: Record<string, LedgerEntry> = {};
  let changed = false;
  const iso = now.toISOString();
  const seen = new Set<string>();
  for (const c of current) {
    const k = keyOf(c);
    if (seen.has(k)) continue;
    seen.add(k);
    const fp = fpOf(c);
    const old = prev.items[k];
    if (old && !old.deleted && old.fp === fp) { items[k] = old; continue; }
    changed = true;
    items[k] = { fp, seq: ++seq, at: iso, kind: c.kind, title: c.title, url: c.url, when: c.kind === "event" ? c.startAt ?? null : c.dueAt ?? null, done: c.done };
  }
  for (const [k, old] of Object.entries(prev.items)) {
    if (seen.has(k)) continue;
    if (old.deleted) {
      if (Date.parse(old.at) >= now.getTime() - OUTBOX_RULES.tombstoneDays * DAY) items[k] = old;
      else changed = true;
      continue;
    }
    changed = true;
    if (agedOut(old, now)) continue;
    items[k] = { ...old, deleted: true, seq: ++seq, at: iso };
  }
  return { ledger: { seq, items }, changed };
}

/** The cursor the app sends back as ?since=; anything else (or nothing) means "everything, from the start". */
export function parseSince(raw: string | null | undefined, ledger: OutboxLedger): number | null {
  if (!raw) return null;
  if (!/^\d{1,15}$/.test(raw)) return null;
  const n = Number(raw);
  return n <= ledger.seq ? n : null;
}

/**
 * What the app gets: from the start (since null) every live item; else what changed after `since`, tombstones
 * included. The cursor is the ledger's sequence number.
 */
export function outboxPage(ledger: OutboxLedger, current: OutboxCurrent[], since: number | null): { items: OutboxItem[]; cursor: string } {
  const byKey = new Map(current.map((c) => [keyOf(c), c]));
  const out: OutboxItem[] = [];
  const entries = Object.entries(ledger.items).sort(([, a], [, b]) => a.seq - b.seq);
  for (const [k, e] of entries) {
    if (since === null ? e.deleted : e.seq <= since) continue;
    const c = byKey.get(k);
    const id = k.slice(k.indexOf(":") + 1);
    if (e.deleted || !c) {
      out.push({ id, kind: e.kind, title: e.title, done: e.done, deleted: true, updatedAt: e.at, url: e.url });
      continue;
    }
    out.push({
      id: c.id, kind: c.kind, title: c.title, done: c.done, deleted: false, updatedAt: e.at, url: c.url,
      ...(c.notes ? { notes: c.notes } : {}),
      ...(c.dueAt ? { dueAt: c.dueAt } : {}),
      ...(c.startAt ? { startAt: c.startAt } : {}),
      ...(c.endAt ? { endAt: c.endAt } : {}),
      ...(c.kind === "event" ? { allDay: !!c.allDay } : {}),
    });
  }
  return { items: out, cursor: String(ledger.seq) };
}

/** Reminders My Graph made from the Mac's own Reminders are not handed back (the Mac has them already). */
export const MAC_REMINDER_MARK = "in Reminders on your Mac.";

export const ackBody = z.object({ id: z.string().uuid(), kind: z.literal("reminder"), done: z.literal(true) }).strict();

export const deviceBody = z.object({
  deviceName: z.string().trim().min(1).max(200),
  appVersion: z.string().trim().min(1).max(40),
}).strict();
