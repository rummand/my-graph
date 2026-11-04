/**
 * Google Calendar, read-only (calendar.readonly). Per chosen calendar: a first full read (repeating events expanded,
 * kept from a year back to two years ahead), then incremental reads with the syncToken Google hands back. A 410 means
 * the token expired: the one reset path reads every calendar again; events already stored are matched by iCalUID, so
 * nothing doubles. Events become proposed timeline events (a change set), deduplicated by iCalUID with the same event
 * from an .ics link or another parent's calendar.
 */
import { z } from "zod";
import { CursorExpired } from "../errors";
import { defineManifest } from "../manifest";
import { cursorOf } from "../state";
import type { RunContext } from "../types";
import { bodyOf, unexpected } from "../oauth/client";
import type { SyncDeps } from "../oauth/deps";
import { account, oauthSecrets, visibility } from "../oauth/fields";
import type { EventItem } from "../oauth/sink";
import { googleEvent, type GoogleEvent } from "./map";

export const googleCalendarConfig = z.object({
  /** Calendar ids; "primary" is the person's own calendar. */
  calendars: z.array(z.string().trim().min(1).max(300)).min(1).max(10).default(["primary"]),
  personNodeId: z.uuid().nullish(),
  visibility,
  account,
});
export type GoogleCalendarConfig = z.infer<typeof googleCalendarConfig>;

export const googleCalendarManifest = defineManifest({
  id: "google_calendar", version: "1", status: "official", icon: "calendar",
  auth: { type: "oauth2" },
  config: googleCalendarConfig,
  secrets: oauthSecrets,
  fields: [
    { key: "calendars", kind: "list", placeholder: "primary" },
    { key: "personNodeId", kind: "person" },
    { key: "visibility", kind: "visibility" },
  ],
  streams: [{ name: "events", key: "iCalUID", cursor: "syncToken per calendar", resetOn: [410] }],
  schedule: { everyMinutes: 30 },
  rateLimit: { perMinute: 300, backoff: "exponential" },
  maps: { events: "event" },
});

type CalCursor = { syncToken?: string | null; pageToken?: string | null; name?: string | null };
export type GoogleCalendarCursor = { calendars?: Record<string, CalCursor> };

const PAST_DAYS = 365;
const FUTURE_DAYS = 730;
const MAX_PAGES_PER_RUN = 20;

export function inWindow(e: EventItem, now: Date): boolean {
  const t = e.start.getTime();
  return t >= now.getTime() - PAST_DAYS * 86_400_000 && t <= now.getTime() + FUTURE_DAYS * 86_400_000;
}

export async function syncGoogleCalendar(ctx: RunContext<GoogleCalendarConfig>, d: SyncDeps): Promise<void> {
  let cur: GoogleCalendarCursor = cursorOf<GoogleCalendarCursor>(ctx.state(), "events") ?? {};
  let pages = 0;
  for (const calId of ctx.config.calendars) {
    let c: CalCursor = cur.calendars?.[calId] ?? {};
    if (c.name === undefined) {
      const r = await d.api({ url: `${d.base.calendar}/users/me/calendarList/${encodeURIComponent(calId)}` });
      if (r.status === 404) { ctx.log(`The calendar "${calId}" isn't in this Google account; it was skipped.`); ctx.count("events", "skipped"); continue; }
      if (r.status !== 200) throw unexpected(r, "Google", "the calendar");
      c = { ...c, name: bodyOf<{ summary?: string; summaryOverride?: string }>(r, "Google").summaryOverride ?? bodyOf<{ summary?: string }>(r, "Google").summary ?? calId };
    }
    for (;;) {
      if (pages++ >= MAX_PAGES_PER_RUN) { ctx.log("Stopped for now; the rest of the calendar comes in the next run."); return; }
      const q = new URLSearchParams({ singleEvents: "true", maxResults: "250" });
      if (c.pageToken) q.set("pageToken", c.pageToken);
      if (c.syncToken) q.set("syncToken", c.syncToken);
      else q.set("showDeleted", "false");
      const r = await d.api({ url: `${d.base.calendar}/calendars/${encodeURIComponent(calId)}/events?${q}` });
      if (r.status === 410) throw new CursorExpired("events", 410);
      if (r.status === 404) { ctx.log(`The calendar "${c.name ?? calId}" can no longer be read; it was skipped.`); break; }
      if (r.status !== 200) throw unexpected(r, "Google", "the calendar's events");
      const page = bodyOf<{ items?: GoogleEvent[]; nextPageToken?: string; nextSyncToken?: string; summary?: string }>(r, "Google");
      const items: EventItem[] = [];
      const removed: string[] = [];
      for (const raw of page.items ?? []) {
        const e = googleEvent(raw);
        if (!e) { ctx.count("events", "skipped"); continue; }
        if ("removed" in e) { removed.push(e.removed); continue; }
        if (!inWindow(e, ctx.now)) continue;
        items.push(e);
      }
      ctx.count("events", "fetched", items.length);
      // Commit the position with what it brought: the next page, or (at the end) the sync token for next time.
      c = page.nextPageToken
        ? { ...c, pageToken: page.nextPageToken }
        : { name: c.name ?? page.summary ?? calId, syncToken: page.nextSyncToken ?? c.syncToken ?? null, pageToken: null };
      cur = { calendars: { ...(cur.calendars ?? {}), [calId]: c } };
      if (items.length || removed.length) {
        await d.sink.events(ctx as RunContext, "events", items, removed, c.name ?? null, { visibility: ctx.config.visibility ?? "private", personNodeId: ctx.config.personNodeId }, cur);
      } else {
        await d.sink.cursor(ctx as RunContext, "events", cur);
      }
      if (!page.nextPageToken) break;
    }
  }
}
