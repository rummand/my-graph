/**
 * My Graph for Mac (pure, no DB): the connection's settings, the helper token and pairing code, what the helper is told
 * to send, and how its cursors move. The helper on the person's Mac reads Messages (chat.db) and Notes and sends JSON
 * batches (imessagePayload / appleNotesPayload); everything it sends becomes library sources and proposals.
 *
 * Privacy first: nothing is sent until the person turns Messages and/or Notes on, and Messages sends only the
 * conversations they chose (or, if they say so, conversations with people already in this graph). The helper sends
 * the list of conversations (names and numbers, no messages) so the person can choose here.
 */
import { createHash, randomBytes, randomInt } from "node:crypto";
import { z } from "zod";
import { matchPerson, normEmail, normPhone } from "@/lib/importers/match";
import type { ImportKnown } from "@/lib/importers/types";

export const MAC_CONNECTOR = "mac";
export const PAIRING_MINUTES = 15;
/** What the helper aims for per batch (the door accepts a little more). */
export const MAX_BATCH_BYTES = 5_000_000;
export const DOOR_MAX_BYTES = 8 * 1024 * 1024;
export const CATALOG_MAX_CHATS = 500;
export const CATALOG_MAX_FOLDERS = 200;

const chatId = z.string().min(1).max(300);

export const catalogChat = z.object({
  id: chatId,
  name: z.string().max(300).optional(),
  participants: z.array(z.object({ handle: z.string().max(320), name: z.string().max(200).optional() })).max(30).default([]),
  count: z.number().int().min(0).max(100_000_000).default(0),
  lastAt: z.string().datetime({ offset: true }).optional(),
});
export type CatalogChat = z.infer<typeof catalogChat>;

/** What the helper reports it can see: conversations (no messages) and Notes folders (no notes). */
export const catalogBody = z.object({
  device: z.string().max(80).optional(),
  chats: z.array(catalogChat).max(CATALOG_MAX_CHATS).default([]),
  folders: z.array(z.object({ name: z.string().min(1).max(300), count: z.number().int().min(0).max(1_000_000).default(0) })).max(CATALOG_MAX_FOLDERS).default([]),
  /** What the helper could read: false when Full Disk Access (Messages) or Automation (Notes) is missing. */
  canRead: z.object({ messages: z.boolean(), notes: z.boolean() }).partial().optional(),
}).strict();
export type CatalogBody = z.infer<typeof catalogBody>;

export const SINCE = ["3m", "1y", "all"] as const;
export type Since = (typeof SINCE)[number];

export const macConfig = z.object({
  visibility: z.enum(["private", "parents", "household"]).default("private"),
  messages: z.object({
    enabled: z.boolean().default(false),
    /** chosen: only the conversations in `chats`; known: conversations with someone already in this graph. */
    scope: z.enum(["chosen", "known"]).default("chosen"),
    chats: z.array(chatId).max(CATALOG_MAX_CHATS).default([]),
    since: z.enum(SINCE).default("1y"),
  }).default({ enabled: false, scope: "chosen", chats: [], since: "1y" }),
  notes: z.object({
    enabled: z.boolean().default(false),
    /** null = every folder (Recently Deleted and locked notes are never sent). */
    folders: z.array(z.string().min(1).max(300)).max(CATALOG_MAX_FOLDERS).nullable().default(null),
  }).default({ enabled: false, folders: null }),
  /** Pairing in progress: the hash of the one-time code, and when it ends. */
  pairing: z.object({ hash: z.string().regex(/^[0-9a-f]{64}$/), expiresAt: z.string() }).nullish(),
  /** The paired helper: only a hash of its token is kept. */
  helper: z.object({
    tokenHash: z.string().regex(/^[0-9a-f]{64}$/), pairedAt: z.string(), device: z.string().max(80).nullish(), lastSeenAt: z.string().nullish(),
  }).nullish(),
  catalog: z.object({
    at: z.string(),
    chats: z.array(catalogChat).max(CATALOG_MAX_CHATS),
    folders: z.array(z.object({ name: z.string(), count: z.number() })).max(CATALOG_MAX_FOLDERS),
    canRead: z.object({ messages: z.boolean(), notes: z.boolean() }).partial().optional(),
  }).optional(),
  lastSend: z.object({
    at: z.string(),
    runId: z.string().optional(),
    messages: z.number().int().optional(),
    chats: z.number().int().optional(),
    notes: z.number().int().optional(),
    sourceIds: z.array(z.string()).max(50).optional(),
  }).optional(),
});
export type MacConfig = z.infer<typeof macConfig>;

/** Nothing secret is stored encrypted: the helper token is kept only as a hash in the config. */
export const macSecrets = z.object({});

/* ── Codes and tokens ─────────────────────────────────────────────────────────────────────────────────── */

const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

export function newPairingCode(): string {
  let s = "";
  for (let i = 0; i < 10; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return `${s.slice(0, 5)}-${s.slice(5)}`;
}

export function normaliseCode(raw: string): string {
  return raw.toUpperCase().replace(/[^0-9A-Z]/g, "");
}

export function pairingHash(code: string): string {
  return createHash("sha256").update(`my-graph mac pairing|${normaliseCode(code)}`).digest("hex");
}

export const TOKEN_PREFIX = "mgmac_";

/** A fresh helper token (256 bits). Shown to the helper once; only its hash is stored. */
export function newHelperToken(): string {
  return TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

export function tokenHash(token: string): string {
  return createHash("sha256").update(`my-graph mac helper|${token}`).digest("hex");
}

/** The token from `Authorization: Bearer mgmac_…`, or null when it is missing or not shaped like ours. */
export function bearerToken(header: string | null | undefined): string | null {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header ?? "");
  if (!m) return null;
  const t = m[1];
  return t.startsWith(TOKEN_PREFIX) && /^[A-Za-z0-9_-]{40,80}$/.test(t) ? t : null;
}

/* ── Cursors (kept in connections.state.streams, see connectors/state.ts) ─────────────────────────────── */

export type MessagesCursor = { rowId: number | null; sentChats: string[] };
export type NotesCursor = { updatedAt: string | null };

export function messagesCursor(raw: unknown): MessagesCursor {
  const c = (raw && typeof raw === "object" ? raw : {}) as Partial<MessagesCursor>;
  const rowId = typeof c.rowId === "number" && Number.isSafeInteger(c.rowId) && c.rowId >= 0 ? c.rowId : null;
  return { rowId, sentChats: Array.isArray(c.sentChats) ? c.sentChats.filter((x): x is string => typeof x === "string").slice(0, 5000) : [] };
}

export function notesCursor(raw: unknown): NotesCursor {
  const c = (raw && typeof raw === "object" ? raw : {}) as Partial<NotesCursor>;
  return { updatedAt: typeof c.updatedAt === "string" && !Number.isNaN(Date.parse(c.updatedAt)) ? c.updatedAt : null };
}

/** What one batch from the helper says about where it got to. */
export const batchEnvelope = z.object({
  /** The helper's run (one per time it runs); the batches of one run are shown as one run on the connection. */
  runId: z.string().uuid(),
  /** Names the batch at the source ("f-120-845"); the same batch sent again updates instead of duplicating. */
  batch: z.string().regex(/^[A-Za-z0-9._:-]{1,120}$/),
  /** Messages: forward = after the cursor; backfill = the history of conversations chosen since the last send. */
  phase: z.enum(["forward", "backfill"]).default("forward"),
  lastRowId: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  /** Notes: the newest modification time the helper saw (moves the cursor on the final batch). */
  notesCursor: z.string().datetime({ offset: true }).optional(),
  /** Messages: the conversations this run read (on the final batch, their history counts as sent). */
  covered: z.array(chatId).max(5000).optional(),
  /** The last batch of this run for this kind. */
  final: z.boolean().default(false),
  device: z.string().max(80).optional(),
  data: z.unknown(),
});
export type BatchEnvelope = z.infer<typeof batchEnvelope>;

export function nextMessagesCursor(prev: MessagesCursor, b: Pick<BatchEnvelope, "phase" | "lastRowId" | "covered" | "final">, allowed: string[]): MessagesCursor {
  let rowId = prev.rowId;
  if (b.phase === "forward" && typeof b.lastRowId === "number") rowId = Math.max(rowId ?? 0, b.lastRowId);
  let sentChats = prev.sentChats;
  if (b.final) {
    const allow = new Set(allowed);
    sentChats = [...new Set([...prev.sentChats, ...(b.covered ?? [])])].filter((c) => allow.has(c));
  }
  return { rowId, sentChats };
}

export function nextNotesCursor(prev: NotesCursor, b: Pick<BatchEnvelope, "notesCursor" | "final">): NotesCursor {
  if (!b.final || !b.notesCursor) return prev;
  if (!prev.updatedAt) return { updatedAt: b.notesCursor };
  return { updatedAt: Date.parse(b.notesCursor) > Date.parse(prev.updatedAt) ? b.notesCursor : prev.updatedAt };
}

/* ── What the helper is told to send ──────────────────────────────────────────────────────────────────── */

export type HelperSettings = {
  connectionId: string;
  label: string;
  visibility: MacConfig["visibility"];
  maxBatchBytes: number;
  messages: {
    enabled: boolean;
    /** The conversations it may send (chat.guid). Nothing else is read. */
    chats: string[];
    /** Of those, the ones whose history (up to the cursor) hasn't been sent yet. */
    backfill: string[];
    cursor: number | null;
    /** Don't send messages older than this. */
    since: string | null;
    generation: number;
  };
  notes: { enabled: boolean; folders: string[] | null; cursor: string | null; generation: number };
};

export function sinceIso(since: Since, now: Date): string | null {
  if (since === "all") return null;
  const days = since === "3m" ? 92 : 366;
  return new Date(now.getTime() - days * 86_400_000).toISOString();
}

/** Does someone in this conversation match a person in the graph (by phone or email, or a unique name)? */
export function chatHasKnownPerson(chat: Pick<CatalogChat, "participants">, people: ImportKnown[]): boolean {
  for (const p of chat.participants) {
    const handle = p.handle.trim();
    const isEmail = handle.includes("@");
    const clue = { name: p.name ?? null, emails: isEmail ? [normEmail(handle)] : [], phones: !isEmail && normPhone(handle).length >= 8 ? [handle] : [] };
    if (matchPerson(people, clue)) return true;
  }
  return false;
}

/** The conversations the helper may send under these settings. */
export function allowedChats(cfg: MacConfig, people: ImportKnown[]): string[] {
  if (!cfg.messages.enabled) return [];
  if (cfg.messages.scope === "chosen") return [...new Set(cfg.messages.chats)];
  return (cfg.catalog?.chats ?? []).filter((c) => chatHasKnownPerson(c, people)).map((c) => c.id);
}

export function helperSettings(input: {
  connectionId: string; label: string; config: MacConfig; people: ImportKnown[];
  messages: MessagesCursor; notes: NotesCursor; generations: { messages: number; notes: number }; now: Date;
}): HelperSettings {
  const { config: cfg } = input;
  const chats = allowedChats(cfg, input.people);
  const sent = new Set(input.messages.sentChats);
  return {
    connectionId: input.connectionId,
    label: input.label,
    visibility: cfg.visibility,
    maxBatchBytes: MAX_BATCH_BYTES,
    messages: {
      enabled: cfg.messages.enabled,
      chats,
      backfill: input.messages.rowId === null ? [] : chats.filter((c) => !sent.has(c)),
      cursor: input.messages.rowId,
      since: sinceIso(cfg.messages.since, input.now),
      generation: input.generations.messages,
    },
    notes: { enabled: cfg.notes.enabled, folders: cfg.notes.folders, cursor: input.notes.updatedAt, generation: input.generations.notes },
  };
}

/** Keep only what the person allowed (a helper bug or an old helper never gets an unchosen conversation in). */
export function filterChats<T extends { chats: { id: string }[] }>(payload: T, allowed: string[]): { payload: T; dropped: number } {
  const allow = new Set(allowed);
  const kept = payload.chats.filter((c) => allow.has(c.id));
  return { payload: { ...payload, chats: kept }, dropped: payload.chats.length - kept.length };
}

export function filterNotes<T extends { notes: { folder?: string }[] }>(payload: T, folders: string[] | null): { payload: T; dropped: number } {
  if (!folders) return { payload, dropped: 0 };
  const allow = new Set(folders);
  const kept = payload.notes.filter((n) => !!n.folder && allow.has(n.folder));
  return { payload: { ...payload, notes: kept }, dropped: payload.notes.length - kept.length };
}

/** The source's title, in English like every stored title (shown translated where it is read). */
export function batchTitle(kind: "imessage" | "apple_notes", counts: { messages?: number; chats?: number; notes?: number }, device?: string | null): string {
  const from = device ? ` from ${device}` : " from your Mac";
  if (kind === "apple_notes") return `Notes${from}: ${counts.notes ?? 0} ${counts.notes === 1 ? "note" : "notes"}`;
  return `Messages${from}: ${counts.messages ?? 0} ${counts.messages === 1 ? "message" : "messages"} in ${counts.chats ?? 0} ${counts.chats === 1 ? "conversation" : "conversations"}`;
}

/** A device name as the helper reports it, tidied ("Ida's MacBook Air"). */
export function cleanDevice(raw: string | null | undefined): string | null {
  const s = (raw ?? "").replace(/\.local$/i, "").replace(/[\u0000-\u001f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 80);
  return s || null;
}
