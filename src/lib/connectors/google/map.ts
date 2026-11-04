/**
 * Google answers to My Graph's shapes (pure, no network, no DB): Gmail history and labels, Calendar events to the
 * calendar-event shape the .ics connector uses (so dedupe by iCalUID and the proposals are the same), and Drive
 * files to what gets downloaded or exported.
 */
import { fingerprintOf, type IcsEvent } from "../ics/parse";
import type { EventItem } from "../oauth/sink";

/* ── Gmail ──────────────────────────────────────────────────────────────────────────────────────────────── */

/** Gmail's raw message (base64url) as the original bytes. */
export function gmailRaw(b64url: string): Buffer {
  return Buffer.from(b64url.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

const NEVER = new Set(["SPAM", "TRASH", "DRAFT"]);

/** Should a message with these labels come in? An empty choice means all mail except spam, trash and drafts. */
export function gmailWanted(labelIds: string[] | undefined, wanted: string[]): boolean {
  const ids = labelIds ?? [];
  if (ids.some((l) => NEVER.has(l))) return false;
  if (!wanted.length) return true;
  return ids.some((l) => wanted.includes(l));
}

/** `after:2026/08/01`, Gmail's search for "from this day on". */
export function gmailAfter(since: Date): string {
  const d = since.toISOString().slice(0, 10).replace(/-/g, "/");
  return `after:${d}`;
}

type HistoryMsg = { id: string; threadId?: string; labelIds?: string[] };
export type GmailHistory = {
  history?: { messagesAdded?: { message: HistoryMsg }[]; labelsAdded?: { message: HistoryMsg; labelIds?: string[] }[] }[];
  historyId?: string;
  nextPageToken?: string;
};

/** New messages (and messages newly given a chosen label) in a history page, in order, without repeats. */
export function historyMessages(page: GmailHistory, wanted: string[]): { id: string; threadId: string }[] {
  const out: { id: string; threadId: string }[] = [];
  const seen = new Set<string>();
  const add = (m: HistoryMsg) => {
    if (!m?.id || seen.has(m.id) || !gmailWanted(m.labelIds, wanted)) return;
    seen.add(m.id);
    out.push({ id: m.id, threadId: m.threadId ?? m.id });
  };
  for (const h of page.history ?? []) {
    for (const a of h.messagesAdded ?? []) add(a.message);
    for (const a of h.labelsAdded ?? []) if (wanted.length && (a.labelIds ?? []).some((l) => wanted.includes(l))) add(a.message);
  }
  return out;
}

/** Gmail's cursor: the mailbox history id to read on from, or a first full read under way. */
export type GmailCursor = {
  historyId?: string;
  /** During the first read: which label is being listed and the page within it. */
  initial?: { labelIndex: number; pageToken: string | null; since: string } | null;
};

export function gmailPlan(cursor: GmailCursor | undefined): "start" | "initial" | "incremental" {
  if (!cursor?.historyId) return "start";
  return cursor.initial ? "initial" : "incremental";
}

/* ── Calendar ───────────────────────────────────────────────────────────────────────────────────────────── */

export type GoogleEvent = {
  id: string;
  status?: "confirmed" | "tentative" | "cancelled";
  iCalUID?: string;
  summary?: string;
  description?: string;
  location?: string;
  htmlLink?: string;
  start?: { date?: string; dateTime?: string; timeZone?: string };
  end?: { date?: string; dateTime?: string; timeZone?: string };
  originalStartTime?: { date?: string; dateTime?: string };
  recurringEventId?: string;
  sequence?: number;
  updated?: string;
  organizer?: { email?: string; displayName?: string };
};

const clean = (s: unknown, max: number) => (typeof s === "string" && s.trim() ? s.replace(/\r\n?/g, "\n").trim().slice(0, max) : null);

/** The UTC instant of a Google date: a dateTime carries its offset; an all-day date is that day at midnight UTC. */
function instant(t: { date?: string; dateTime?: string } | undefined): { at: Date; date: string | null } | null {
  if (!t) return null;
  if (t.dateTime) {
    const d = new Date(t.dateTime);
    return Number.isNaN(d.getTime()) ? null : { at: d, date: null };
  }
  if (t.date && /^\d{4}-\d{2}-\d{2}$/.test(t.date)) return { at: new Date(`${t.date}T00:00:00Z`), date: t.date };
  return null;
}

/**
 * A Google event as a calendar event, or `{ removed }` when the answer only says it is gone (an incremental read
 * gives cancelled events with little more than their id). One occurrence of a repeating event gets the key
 * iCalUID#<its original start>, like a repeat read from an .ics link.
 */
export function googleEvent(ev: GoogleEvent): EventItem | { removed: string } | null {
  const providerId = `gcal:${ev.id}`;
  const start = instant(ev.start);
  if (ev.status === "cancelled" && (!start || !ev.summary)) return { removed: providerId };
  if (!start) return null;
  const uid = ev.iCalUID ?? `${ev.id}@google.com`;
  const orig = ev.recurringEventId ? instant(ev.originalStartTime) : null;
  const key = orig ? `${uid}#${orig.date ?? orig.at.toISOString()}` : uid;
  let end = instant(ev.end)?.at ?? null;
  if (end && end.getTime() <= start.at.getTime()) end = null;
  const base = {
    uid, summary: clean(ev.summary, 300) ?? "(no title)", description: clean(ev.description, 4000), location: clean(ev.location, 300),
    url: ev.htmlLink ?? null, start: start.at, end, allDay: !!start.date, date: start.date,
    status: (ev.status ?? "confirmed") as IcsEvent["status"], categories: [] as string[],
    organizer: ev.organizer?.displayName ?? ev.organizer?.email ?? null,
  };
  return {
    ...base, key, providerId, sequence: ev.sequence ?? 0, lastModified: ev.updated ?? null, recurring: !!orig, fingerprint: fingerprintOf(base),
  };
}

/* ── Drive ──────────────────────────────────────────────────────────────────────────────────────────────── */

export const FOLDER_MIME = "application/vnd.google-apps.folder";

/** Google's own formats are exported (Docs as Word, Sheets as Excel, Slides as PowerPoint); the rest is downloaded. */
export function driveExport(mimeType: string): { mime: string; ext: string } | "download" | null {
  switch (mimeType) {
    case "application/vnd.google-apps.document": return { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ext: "docx" };
    case "application/vnd.google-apps.spreadsheet": return { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ext: "xlsx" };
    case "application/vnd.google-apps.presentation": return { mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", ext: "pptx" };
    case FOLDER_MIME: return null;
    default: return mimeType.startsWith("application/vnd.google-apps.") ? null : "download";
  }
}

export type DriveFile = {
  id: string; name: string; mimeType: string; parents?: string[]; md5Checksum?: string; modifiedTime?: string; version?: string;
  size?: string; trashed?: boolean; webViewLink?: string;
};

export type Picked = { id: string; name: string; mimeType: string };

/** A file is ours to read when it was picked, or sits in a picked folder (or one inside it that we've seen). */
export function driveInScope(f: Pick<DriveFile, "id" | "parents">, picked: Set<string>, folders: Set<string>): boolean {
  return picked.has(f.id) || (f.parents ?? []).some((p) => folders.has(p));
}

/** What changes when the file changes: its checksum, else its version, else when it was modified. */
export function driveVersion(f: DriveFile): string {
  return f.md5Checksum ?? (f.version ? `v${f.version}` : f.modifiedTime ?? "0");
}

/** The name a file is stored under (an exported Google Doc gets the extension of what it was exported as). */
export function driveName(f: Pick<DriveFile, "name">, exp: { ext: string } | "download"): string {
  if (exp === "download") return f.name;
  return f.name.toLowerCase().endsWith(`.${exp.ext}`) ? f.name : `${f.name}.${exp.ext}`;
}

export type DriveCursor = {
  /** changes.list position. */
  pageToken?: string;
  /** Picked items already read in full (folders listed, files downloaded once). */
  seeded?: string[];
  /** Folders inside picked folders that we have seen, so files added deep inside are still in scope. */
  folders?: string[];
};
