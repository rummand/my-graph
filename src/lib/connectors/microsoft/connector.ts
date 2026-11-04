/**
 * Microsoft 365 and Outlook.com through Microsoft Graph, read-only (Mail.Read, Calendars.Read, Files.Read,
 * offline_access), with the household's own Microsoft app. One sign-in, three streams, each switchable:
 *   mail:     delta per chosen mail folder (from the start date on); each new message is fetched as its original MIME
 *             ($value) and stored as an email source, threadKey from the conversation id.
 *   calendar: calendarView delta over a window (a year back, two years ahead); occurrences of repeating events come
 *             expanded, each with its own iCalUId; they become proposed timeline events.
 *   files:    delta per OneDrive folder the person picked; new and changed files go through the reading queue.
 * Every stream keeps the delta link Microsoft hands back. A 410, or a resync code (syncStateNotFound,
 * resyncRequired), sends the stream down the one reset path; what is stored is skipped on the way back.
 */
import { z } from "zod";
import { CursorExpired } from "../errors";
import { defineManifest } from "../manifest";
import { cursorOf } from "../state";
import type { RunContext } from "../types";
import { bodyOf, unexpected, type ApiResponse } from "../oauth/client";
import type { SyncDeps } from "../oauth/deps";
import { account, oauthSecrets, sinceDay, sinceField, visibility } from "../oauth/fields";
import type { EventItem, MailItem } from "../oauth/sink";
import { MAX_UPLOAD_BYTES } from "@/lib/ingest/mime";
import { deltaNext, driveFiles, driveItemVersion, graphEvent, graphResetSignal, sameApi, type DeltaPage, type DriveItem, type GraphEvent, type GraphMessage } from "./map";

const folderRef = z.object({ id: z.string().trim().min(1).max(300), name: z.string().max(300) });

export const microsoftConfig = z.object({
  mail: z.boolean().default(true),
  /** Mail folder ids, or well-known names ("inbox"). */
  mailFolders: z.array(folderRef).max(10).default([{ id: "inbox", name: "Inbox" }]),
  since: sinceField,
  calendar: z.boolean().default(true),
  personNodeId: z.uuid().nullish(),
  /** OneDrive folders the person picked (none = files are not read). */
  driveFolders: z.array(folderRef.extend({ path: z.string().max(1000).optional() })).max(20).default([]),
  visibility,
  account,
});
export type MicrosoftConfig = z.infer<typeof microsoftConfig>;

export const microsoftManifest = defineManifest({
  id: "microsoft", version: "1", status: "official", icon: "mail",
  auth: { type: "oauth2" },
  config: microsoftConfig,
  secrets: oauthSecrets,
  fields: [
    { key: "mail", kind: "boolean" },
    { key: "since", kind: "date" },
    { key: "calendar", kind: "boolean" },
    { key: "personNodeId", kind: "person" },
    { key: "visibility", kind: "visibility" },
  ],
  streams: [
    { name: "mail", key: "internetMessageId", cursor: "deltaLink per folder", resetOn: [410, "syncStateNotFound"] },
    { name: "calendar", key: "iCalUId", cursor: "deltaLink + window", resetOn: [410, "syncStateNotFound"] },
    { name: "files", key: "driveItem id", cursor: "deltaLink per picked folder", resetOn: [410, "syncStateNotFound"] },
  ],
  schedule: { everyMinutes: 15 },
  rateLimit: { perMinute: 300, backoff: "exponential" },
  maps: { mail: "correspondence", calendar: "event", files: "document" },
});

type LinkCursor = { link?: string | null; done?: boolean };
export type MsMailCursor = { folders?: Record<string, LinkCursor> };
export type MsCalendarCursor = LinkCursor & { windowEnd?: string };
export type MsFilesCursor = { folders?: Record<string, LinkCursor> };

const MAX_MAIL_PER_RUN = 200;
const MAX_FILES_PER_RUN = 60;
const MAX_PAGES = 30;
const PAST_DAYS = 365;
const FUTURE_DAYS = 730;
const MAX_RAW_BYTES = 40 * 1024 * 1024;

function checkReset(stream: string, r: ApiResponse): void {
  const why = graphResetSignal(r.status, r.body.toString("utf8").slice(0, 4000));
  if (why) throw new CursorExpired(stream, why === "410" ? 410 : why);
}

/** Follow a saved link only when it points back at Graph; otherwise start that stream again. */
function linkOk(stream: string, link: string, base: string): string {
  if (!sameApi(link, base)) throw new CursorExpired(stream, "syncStateNotFound");
  return link;
}

export async function syncMicrosoftMail(ctx: RunContext<MicrosoftConfig>, d: SyncDeps): Promise<void> {
  let cur: MsMailCursor = cursorOf<MsMailCursor>(ctx.state(), "mail") ?? {};
  let left = MAX_MAIL_PER_RUN;
  const since = sinceDay(ctx.config.since, ctx.now).toISOString();
  for (const folder of ctx.config.mailFolders) {
    let link = cur.folders?.[folder.id]?.link ?? null;
    let pages = 0;
    for (;;) {
      if (pages++ >= MAX_PAGES || left <= 0) { ctx.log("Stopped for now; more mail comes in the next run."); return; }
      const url = link ? linkOk("mail", link, d.base.graph)
        : `${d.base.graph}/me/mailFolders/${encodeURIComponent(folder.id)}/messages/delta?${new URLSearchParams({ $select: "id,conversationId,receivedDateTime,webLink", $filter: `receivedDateTime ge ${since}` })}`;
      const r = await d.api({ url, headers: { prefer: "odata.maxpagesize=50" } });
      checkReset("mail", r);
      if (r.status === 404 && !link) { ctx.log(`The mail folder "${folder.name}" doesn't exist any more; it was skipped.`); break; }
      if (r.status !== 200) throw unexpected(r, "Microsoft", `the mail folder "${folder.name}"`);
      const page = bodyOf<DeltaPage<GraphMessage>>(r, "Microsoft");
      const msgs = (page.value ?? []).filter((m) => !m["@removed"] && m.id);
      const known = await d.sink.knownMail(ctx as RunContext, msgs.map((m) => `outlook:${m.id}`));
      const unknown = msgs.filter((m) => !known.has(`outlook:${m.id}`));
      const todo = unknown.slice(0, left);
      // A page that is only partly read (the run's limit) keeps the link it was read from.
      const partial = todo.length < unknown.length;
      ctx.count("mail", "unchanged", msgs.length - unknown.length);
      const items: MailItem[] = [];
      for (const m of todo) {
        const raw = await d.api({ url: `${d.base.graph}/me/messages/${encodeURIComponent(m.id)}/$value`, maxBytes: MAX_RAW_BYTES, headers: { accept: "*/*" } });
        if (raw.status === 404) { ctx.count("mail", "skipped"); continue; }
        if (raw.status !== 200) throw unexpected(raw, "Microsoft", "a message");
        items.push({ raw: raw.body, providerId: `outlook:${m.id}`, threadKey: `outlook:${m.conversationId ?? m.id}`, folder: folder.name, webUrl: m.webLink ?? null });
      }
      left -= todo.length;
      ctx.count("mail", "fetched", items.length);
      const step = deltaNext(page);
      const nextLink = partial ? link : step ? ("next" in step ? step.next : step.delta) : link;
      cur = { folders: { ...(cur.folders ?? {}), [folder.id]: { link: nextLink, done: !!step && "delta" in step && !partial } } };
      if (items.length) await d.sink.mail(ctx as RunContext, "mail", items, cur, ctx.config.visibility ?? "private");
      else await d.sink.cursor(ctx as RunContext, "mail", cur);
      if (partial || !step || "delta" in step) break;
      link = step.next;
    }
  }
}

export async function syncMicrosoftCalendar(ctx: RunContext<MicrosoftConfig>, d: SyncDeps): Promise<void> {
  let cur: MsCalendarCursor = cursorOf<MsCalendarCursor>(ctx.state(), "calendar") ?? {};
  // The window is fixed when a delta read starts; once its end is less than a year away, start a fresh window.
  if (cur.link && cur.windowEnd && Date.parse(cur.windowEnd) < ctx.now.getTime() + 365 * 86_400_000) throw new CursorExpired("calendar", "window");
  let link = cur.link ?? null;
  let windowEnd = cur.windowEnd ?? new Date(ctx.now.getTime() + FUTURE_DAYS * 86_400_000).toISOString();
  for (let pages = 0; pages < MAX_PAGES; pages++) {
    const url = link ? linkOk("calendar", link, d.base.graph)
      : `${d.base.graph}/me/calendarView/delta?${new URLSearchParams({ startDateTime: new Date(ctx.now.getTime() - PAST_DAYS * 86_400_000).toISOString(), endDateTime: windowEnd })}`;
    const r = await d.api({ url, headers: { prefer: 'outlook.timezone="UTC", odata.maxpagesize=100' } });
    checkReset("calendar", r);
    if (r.status !== 200) throw unexpected(r, "Microsoft", "the calendar");
    const page = bodyOf<DeltaPage<GraphEvent>>(r, "Microsoft");
    const items: EventItem[] = [];
    const removed: string[] = [];
    for (const raw of page.value ?? []) {
      const e = graphEvent(raw);
      if (!e) continue;
      if ("removed" in e) removed.push(e.removed);
      else items.push(e);
    }
    ctx.count("calendar", "fetched", items.length);
    const step = deltaNext(page);
    cur = { link: step ? ("next" in step ? step.next : step.delta) : link, windowEnd, done: !!step && "delta" in step };
    if (items.length || removed.length) {
      await d.sink.events(ctx as RunContext, "calendar", items, removed, "Outlook", { visibility: ctx.config.visibility ?? "private", personNodeId: ctx.config.personNodeId }, cur);
    } else {
      await d.sink.cursor(ctx as RunContext, "calendar", cur);
    }
    if (!step || "delta" in step) return;
    link = step.next;
    windowEnd = cur.windowEnd!;
  }
  ctx.log("Stopped for now; the rest of the calendar comes in the next run.");
}

export async function syncOneDrive(ctx: RunContext<MicrosoftConfig>, d: SyncDeps): Promise<void> {
  let cur: MsFilesCursor = cursorOf<MsFilesCursor>(ctx.state(), "files") ?? {};
  let left = MAX_FILES_PER_RUN;
  for (const folder of ctx.config.driveFolders) {
    let link = cur.folders?.[folder.id]?.link ?? null;
    for (let pages = 0; pages < MAX_PAGES; pages++) {
      const url = link ? linkOk("files", link, d.base.graph) : `${d.base.graph}/me/drive/items/${encodeURIComponent(folder.id)}/delta`;
      const r = await d.api({ url });
      checkReset("files", r);
      if (r.status === 404 && !link) { ctx.log(`The OneDrive folder "${folder.name}" can't be found any more; pick it again.`); break; }
      if (r.status !== 200) throw unexpected(r, "Microsoft", `the OneDrive folder "${folder.name}"`);
      const page = bodyOf<DeltaPage<DriveItem>>(r, "Microsoft");
      let stopped = false;
      for (const f of driveFiles(page.value ?? [])) {
        if (left <= 0) { stopped = true; break; }
        if (await readDriveItem(ctx, d, f)) left--;
      }
      if (stopped) { ctx.log("Stopped for now; more files come in the next run."); return; }
      const step = deltaNext(page);
      cur = { folders: { ...(cur.folders ?? {}), [folder.id]: { link: step ? ("next" in step ? step.next : step.delta) : link, done: !!step && "delta" in step } } };
      await d.sink.cursor(ctx as RunContext, "files", cur);
      if (!step || "delta" in step) break;
      link = step.next;
    }
  }
}

/** Download one OneDrive file (the content address redirects to a pre-signed download, fetched without the token). */
async function readDriveItem(ctx: RunContext<MicrosoftConfig>, d: SyncDeps, f: DriveItem): Promise<boolean> {
  const version = driveItemVersion(f);
  if ((await d.sink.fileVersion(ctx as RunContext, `onedrive:${f.id}`)) === version) { ctx.count("files", "unchanged"); return false; }
  if ((f.size ?? 0) > MAX_UPLOAD_BYTES) { ctx.log(`"${f.name}" is over 50 MB; it was left out.`); ctx.count("files", "skipped"); return false; }
  let r = await d.api({ url: `${d.base.graph}/me/drive/items/${encodeURIComponent(f.id)}/content`, headers: { accept: "*/*" }, maxBytes: MAX_UPLOAD_BYTES + 1024 });
  if ((r.status === 302 || r.status === 301 || r.status === 307) && r.headers.location) {
    r = await d.api({ url: new URL(r.headers.location, d.base.graph).toString(), noAuth: true, headers: { accept: "*/*" }, maxBytes: MAX_UPLOAD_BYTES + 1024, timeoutMs: 120_000 });
  }
  if (r.status === 404) { ctx.count("files", "skipped"); return false; }
  if (r.status !== 200) throw unexpected(r, "Microsoft", `"${f.name}"`);
  ctx.count("files", "fetched");
  await d.sink.file(ctx as RunContext, "files", {
    externalId: `onedrive:${f.id}`, name: f.name!, mime: f.file?.mimeType ?? null, bytes: new Uint8Array(r.body),
    modifiedAt: f.lastModifiedDateTime ? new Date(f.lastModifiedDateTime) : null, url: f.webUrl ?? null, version,
    path: f.parentReference?.path?.replace(/^\/drive\/root:/, "") ?? null, provider: "onedrive",
  }, ctx.config.visibility ?? "private");
  return true;
}

export async function syncMicrosoft(ctx: RunContext<MicrosoftConfig>, d: SyncDeps): Promise<void> {
  if (ctx.config.mail) await syncMicrosoftMail(ctx, d);
  if (ctx.config.calendar) await syncMicrosoftCalendar(ctx, d);
  if (ctx.config.driveFolders.length) await syncOneDrive(ctx, d);
}
