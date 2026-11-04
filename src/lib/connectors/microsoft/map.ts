/**
 * Microsoft Graph answers to My Graph's shapes (pure): delta pages, the "start again" signals (410, syncStateNotFound,
 * resyncRequired), calendar events (asked for in UTC) as the calendar-event shape the .ics connector uses, and OneDrive
 * items as files to download.
 */
import { fingerprintOf, type IcsEvent } from "../ics/parse";
import type { EventItem } from "../oauth/sink";

export type DeltaPage<T> = { value?: T[]; "@odata.nextLink"?: string; "@odata.deltaLink"?: string };

/** Where a delta read goes next: another page, or the delta link to keep for next time. */
export function deltaNext<T>(page: DeltaPage<T>): { next: string } | { delta: string } | null {
  if (page["@odata.nextLink"]) return { next: page["@odata.nextLink"] };
  if (page["@odata.deltaLink"]) return { delta: page["@odata.deltaLink"] };
  return null;
}

const RESET_CODES = new Set(["syncstatenotfound", "resyncrequired", "syncstateinvalid", "resyncapplicationrequired", "resyncchangesapplydifferences"]);

/** Does Microsoft say the saved delta link is no good any more? (HTTP 410, or a 400 with one of the resync codes.) */
export function graphResetSignal(status: number, body: string): string | null {
  if (status === 410) return "410";
  if (status !== 400 && status !== 404) return null;
  try {
    const b = JSON.parse(body) as { error?: { code?: string; innerError?: { code?: string } } };
    const codes = [b.error?.code, b.error?.innerError?.code].filter(Boolean).map((c) => String(c).toLowerCase());
    const hit = codes.find((c) => RESET_CODES.has(c));
    return hit ? "syncStateNotFound" : null;
  } catch {
    return null;
  }
}

/** A delta link must point back at Graph itself (it is followed with the person's token). */
export function sameApi(link: string, base: string): boolean {
  try {
    const a = new URL(link), b = new URL(base);
    return a.origin === b.origin && a.pathname.startsWith(b.pathname.replace(/\/+$/, "") + "/");
  } catch {
    return false;
  }
}

export type GraphMessage = { id: string; conversationId?: string; receivedDateTime?: string; webLink?: string; "@removed"?: unknown };

export type GraphEvent = {
  id: string;
  iCalUId?: string;
  subject?: string;
  bodyPreview?: string;
  start?: { dateTime?: string; timeZone?: string };
  end?: { dateTime?: string; timeZone?: string };
  isAllDay?: boolean;
  isCancelled?: boolean;
  location?: { displayName?: string };
  webLink?: string;
  type?: "singleInstance" | "occurrence" | "exception" | "seriesMaster";
  seriesMasterId?: string;
  lastModifiedDateTime?: string;
  organizer?: { emailAddress?: { name?: string; address?: string } };
  showAs?: string;
  "@removed"?: { reason?: string };
};

const clean = (s: unknown, max: number) => (typeof s === "string" && s.trim() ? s.replace(/\r\n?/g, "\n").trim().slice(0, max) : null);

/** Graph's dateTime in UTC (we ask for UTC with the Prefer header; it comes without an offset). */
export function graphUtc(t: { dateTime?: string; timeZone?: string } | undefined): Date | null {
  if (!t?.dateTime) return null;
  const s = /[zZ]|[+-]\d{2}:\d{2}$/.test(t.dateTime) ? t.dateTime : `${t.dateTime.replace(/(\.\d{3})\d*$/, "$1")}Z`;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** A Graph event as a calendar event, or `{ removed }` for a deleted one. Series masters are skipped (we read occurrences). */
export function graphEvent(ev: GraphEvent): EventItem | { removed: string } | null {
  const providerId = `mscal:${ev.id}`;
  if (ev["@removed"]) return { removed: providerId };
  if (ev.type === "seriesMaster") return null;
  const start = graphUtc(ev.start);
  if (!start) return null;
  let end = graphUtc(ev.end);
  if (end && end.getTime() <= start.getTime()) end = null;
  const allDay = !!ev.isAllDay;
  const uid = ev.iCalUId ?? `${ev.id}@outlook`;
  const base = {
    uid, summary: clean(ev.subject, 300) ?? "(no title)", description: clean(ev.bodyPreview, 4000), location: clean(ev.location?.displayName, 300),
    url: ev.webLink ?? null, start, end, allDay, date: allDay ? start.toISOString().slice(0, 10) : null,
    status: (ev.isCancelled ? "cancelled" : ev.showAs === "tentative" ? "tentative" : "confirmed") as IcsEvent["status"], categories: [] as string[],
    organizer: ev.organizer?.emailAddress?.name ?? ev.organizer?.emailAddress?.address ?? null,
  };
  return {
    ...base, key: uid, providerId, sequence: 0, lastModified: ev.lastModifiedDateTime ?? null,
    recurring: ev.type === "occurrence" || ev.type === "exception", fingerprint: fingerprintOf(base),
  };
}

export type DriveItem = {
  id: string; name?: string; size?: number; cTag?: string; eTag?: string; lastModifiedDateTime?: string; webUrl?: string;
  file?: { mimeType?: string }; folder?: { childCount?: number }; deleted?: unknown; parentReference?: { path?: string; id?: string };
};

/** Files to read from a OneDrive delta page (folders and deleted items are not files). */
export function driveFiles(items: DriveItem[]): DriveItem[] {
  return items.filter((i) => !!i.file && !i.deleted && !!i.name);
}

export function driveItemVersion(i: DriveItem): string {
  return i.cTag ?? i.eTag ?? i.lastModifiedDateTime ?? "0";
}
