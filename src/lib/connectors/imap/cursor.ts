/**
 * IMAP cursor maths, pure. Per folder we keep { uidValidity, lastUid }. A folder's UIDs only mean something while its
 * UIDVALIDITY stays the same; when it changes the server renumbered the folder, so the cursor is reset and the folder is
 * read again from the "since" date (the import skips messages it already has by Message-ID).
 */
export type FolderCursor = { uidValidity: string; lastUid: number };
export type FolderStatus = { uidValidity: bigint | number | string; uidNext?: number; exists?: number };

export type FolderPlan =
  | { mode: "initial"; uidValidity: string; reason: "new" }
  | { mode: "reset"; uidValidity: string; reason: "uidvalidity" }
  | { mode: "incremental"; uidValidity: string; fromUid: number }
  | { mode: "nothing"; uidValidity: string };

export function planFolder(saved: FolderCursor | undefined, status: FolderStatus): FolderPlan {
  const uidValidity = String(status.uidValidity);
  if (!saved) return { mode: "initial", uidValidity, reason: "new" };
  if (saved.uidValidity !== uidValidity) return { mode: "reset", uidValidity, reason: "uidvalidity" };
  // UIDNEXT tells us whether anything arrived since lastUid without asking for it.
  if (typeof status.uidNext === "number" && status.uidNext > 0 && status.uidNext <= saved.lastUid + 1) return { mode: "nothing", uidValidity };
  return { mode: "incremental", uidValidity, fromUid: saved.lastUid + 1 };
}

/** The UID range to fetch for an incremental read ("n:*"). */
export function rangeFrom(fromUid: number): string {
  return `${Math.max(1, Math.floor(fromUid))}:*`;
}

/**
 * The UIDs that are really new. "n:*" always returns at least the newest message, even when its UID is below n,
 * so anything at or below lastUid is dropped. Sorted ascending, unique, capped (the rest waits for the next run).
 */
export function newUids(uids: Iterable<number>, lastUid: number, cap: number): { take: number[]; more: boolean } {
  const all = [...new Set([...uids].filter((u) => Number.isInteger(u) && u > lastUid))].sort((a, b) => a - b);
  return { take: all.slice(0, cap), more: all.length > cap };
}

/** Split UIDs into batches; each batch is committed with its cursor in one transaction. */
export function batches<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** The cursor after a batch: the highest UID that was stored (never moves backwards). */
export function advance(saved: FolderCursor | undefined, uidValidity: string, batchUids: number[]): FolderCursor {
  const base = saved && saved.uidValidity === uidValidity ? saved.lastUid : 0;
  return { uidValidity, lastUid: Math.max(base, ...batchUids, 0) };
}

/** IMAP SEARCH SINCE takes a date (no time); the folder is read from the start of that day. */
export function sinceDate(since: string | undefined, now: Date, defaultDays = 90): Date {
  if (since && /^\d{4}-\d{2}-\d{2}$/.test(since)) {
    const d = new Date(`${since}T00:00:00Z`);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date(now.getTime() - defaultDays * 86_400_000);
}

/** A stable id for a message without a Message-ID header. */
export function imapExternalId(messageId: string | undefined, folder: string, uidValidity: string, uid: number): string {
  return messageId ?? `imap:${folder}:${uidValidity}:${uid}`;
}
