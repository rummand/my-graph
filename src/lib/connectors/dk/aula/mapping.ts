/**
 * What Aula's answers become in My Graph (pure, no DB, no network).
 *
 *   thread + message  → an email-like source per message (kind "email", text/plain): thread key aula:thread:<id>,
 *                       externalId aula:msg:<id>, sender, recipients, institution, the children it regards, the day it
 *                       was sent, a link back to the thread in Aula. Read by the reading queue like any letter.
 *   sensitive thread  → one placeholder source "Sensitive, open in Aula" (no text, never read, never sent to mux).
 *   post              → a source (kind "connector") read by the reading queue (dates, people, deadlines in it).
 *   calendar event    → a source plus a proposed event (and "reply by" reminders), like a calendar feed.
 *   presence          → a dated source per child per day (sick, away, picked up by …): a mark on the timeline.
 *   gallery album     → a link to the album in Aula (title, date, how many pictures). Nothing is downloaded.
 *   people            → children, their school or daycare, and the staff and parents who write, matched to the
 *                       graph's people; the rest proposed, each with a receipt (thread/message id and a quote).
 *
 * Aula's field names are read tolerantly (a missing or renamed field is skipped, never fatal). What Aula says is
 * data, never instructions.
 */
import { detectRole, roleRelation } from "@/lib/meta/roles";
import { createHash } from "node:crypto";
import type { ChangeInput, Receipt } from "@/lib/changes";
import { htmlToText } from "@/lib/ingest/email";
import { sourceTitleKey } from "@/lib/ingest/titles";
import { matchKnownPerson } from "@/lib/ingest/extraction";
import { aulaLinks } from "./constants";

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw => (v && typeof v === "object" && !Array.isArray(v) ? (v as Raw) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown, max = 500): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : typeof v === "number" ? String(v) : null);
const idOf = (v: unknown): string | null => {
  const s = str(v, 120);
  return s && /^[A-Za-z0-9_.:-]+$/.test(s) ? s : null;
};
const numId = (v: unknown): number | null => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);

/** Aula's times: "2026-11-03T14:05:00+01:00", "2026-11-03 14:05:00.0000+0100" or a plain date. */
export function aulaDate(v: unknown): Date | null {
  const s = str(v, 60);
  if (!s) return null;
  let t = s.replace(" ", "T").replace(/\.(\d{3})\d*/, ".$1").replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) t += "T00:00:00Z";
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d;
}

export const fingerprint = (x: unknown) => createHash("sha256").update(JSON.stringify(x)).digest("hex").slice(0, 24);

export const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

/* ── People as Aula names them ────────────────────────────────────────────────────────────────────────── */

export type AulaRole = "staff" | "guardian" | "child" | "other";

/** employee / teacher / guardian / child, wherever Aula put it on this profile. */
export function roleOf(p: unknown): AulaRole {
  const o = obj(p);
  const box = obj(o.mailBoxOwner);
  const raw = [o.role, o.portalRole, o.profileType, box.portalRole, box.profileType, box.role].map((x) => (typeof x === "string" ? x.toLowerCase() : "")).find(Boolean) ?? "";
  if (/employee|teacher|staff|ansat|medarbejder|laerer|lærer|paedagog|pædagog/.test(raw)) return "staff";
  if (/guardian|parent|foraelder|forælder|værge/.test(raw)) return "guardian";
  if (/child|elev|barn|student/.test(raw)) return "child";
  return "other";
}

export type AulaProfile = { key: string; name: string; role: AulaRole; hint: string | null };

export function profileOf(p: unknown): AulaProfile | null {
  const o = obj(p);
  const box = obj(o.mailBoxOwner);
  const name = str(o.fullName ?? o.displayName ?? o.name ?? box.fullName, 160);
  if (!name) return null;
  const id = idOf(o.profileId ?? o.institutionProfileId ?? box.id ?? o.id);
  return { key: id ? `profile:${id}` : `name:${norm(name)}`, name, role: roleOf(o), hint: str(o.metadata ?? o.shortName ?? o.title, 160) };
}

/* ── The signed-in parent, their children and institutions ───────────────────────────────────────────── */

export type AulaChild = { id: number; name: string; institutionProfileId: number | null; institutionName: string | null; institutionCode: string | null };
export type AulaAccount = { name: string | null; profileId: number | null; children: AulaChild[]; institutionProfileIds: number[] };

export function accountFrom(data: unknown): AulaAccount {
  const profiles = arr(obj(data).profiles);
  const out: AulaAccount = { name: null, profileId: null, children: [], institutionProfileIds: [] };
  const seen = new Set<number>();
  for (const raw of profiles) {
    const p = obj(raw);
    out.name ??= str(p.displayName ?? p.name, 160);
    out.profileId ??= numId(p.profileId ?? p.id);
    for (const ip of arr(p.institutionProfiles)) {
      const id = numId(obj(ip).id);
      if (id && !out.institutionProfileIds.includes(id)) out.institutionProfileIds.push(id);
    }
    for (const c of arr(p.children)) {
      const ch = obj(c);
      const ip = obj(ch.institutionProfile);
      const id = numId(ch.id) ?? numId(ip.id);
      const name = str(ch.name ?? ip.name ?? ch.displayName, 160);
      if (!id || !name || seen.has(id)) continue;
      seen.add(id);
      out.children.push({
        id, name, institutionProfileId: numId(ip.id) ?? id,
        institutionName: str(ip.institutionName ?? ch.institutionName, 200), institutionCode: str(ip.institutionCode ?? ch.institutionCode, 40),
      });
    }
  }
  return out;
}

/** Everyone's institution-profile ids (the parent's and each child's): what posts, calendar and gallery are scoped to. */
export function scopeIds(a: AulaAccount): number[] {
  return [...new Set([...a.institutionProfileIds, ...a.children.map((c) => c.institutionProfileId ?? c.id)])];
}

/* ── Threads and messages ─────────────────────────────────────────────────────────────────────────────── */

export type AulaThread = {
  id: string; subject: string; sensitive: boolean; latestAt: Date | null; latestMessageId: string | null;
  creator: AulaProfile | null; recipients: AulaProfile[]; children: string[]; institution: string | null;
};

export function threadOf(raw: unknown): AulaThread | null {
  const t = obj(raw);
  const id = idOf(t.id ?? t.threadId);
  if (!id) return null;
  const latest = obj(t.latestMessage ?? t.lastMessage);
  return {
    id,
    subject: str(t.subject, 250) ?? "(no subject)",
    sensitive: t.sensitive === true || t.isSensitive === true,
    latestAt: aulaDate(latest.sendDateTime ?? t.latestMessageDate ?? t.lastUpdatedDate ?? t.startedTime),
    latestMessageId: idOf(latest.id),
    creator: profileOf(t.creator),
    recipients: arr(t.recipients).map(profileOf).filter((p): p is AulaProfile => !!p).slice(0, 200),
    children: arr(t.regardingChildren).map((c) => str(obj(c).displayName ?? obj(c).name ?? obj(c).fullName, 160)).filter((x): x is string => !!x).slice(0, 20),
    institution: str(t.institutionName ?? obj(t.institution).name ?? t.institutionCode, 200),
  };
}

export type AulaMessage = { id: string; at: Date | null; sender: AulaProfile | null; text: string; attachments: string[]; kind: string };

/** Only real messages: "RecipientAdded" and other system lines are not letters. */
const MESSAGE_TYPES = new Set(["message", "messageedited", "forward", "reply", ""]);

export function messageOf(raw: unknown): AulaMessage | null {
  const m = obj(raw);
  const id = idOf(m.id);
  if (!id) return null;
  const kind = (str(m.messageType, 60) ?? "").toLowerCase();
  if (!MESSAGE_TYPES.has(kind)) return null;
  const textRaw = m.text;
  const html = typeof textRaw === "string" ? textRaw : str(obj(textRaw).html, 200_000) ?? str(obj(textRaw).plain, 200_000) ?? "";
  const attachments = arr(m.attachments).map((a) => {
    const x = obj(a);
    return str(obj(x.file).name ?? obj(obj(x.media).file).name ?? x.name, 200);
  }).filter((x): x is string => !!x).slice(0, 30);
  return { id, at: aulaDate(m.sendDateTime), sender: profileOf(m.sender), text: htmlToText(html).slice(0, 100_000), attachments, kind };
}

export type SourceDraft = {
  externalId: string; kind: "email" | "connector"; title: string; mime: string; text: string | null; sensitive: boolean;
  documentDate: Date | null; precision: "minute" | "day" | null; url: string | null; threadKey: string | null;
  meta: Record<string, unknown>; fingerprint: string;
};

export const threadKeyOf = (threadId: string) => `aula:thread:${threadId}`;
export const messageExternalId = (id: string) => `aula:msg:${id}`;

const roleWord: Record<AulaRole, string> = { staff: "staff", guardian: "parent", child: "child", other: "other" };

/** One Aula message as an email-like source. */
export function messageSource(thread: AulaThread, m: AulaMessage, web: string): SourceDraft {
  const links = aulaLinks(web);
  const from = m.sender?.name ?? thread.creator?.name ?? "Aula";
  const to = thread.recipients.filter((r) => r.key !== m.sender?.key).map((r) => r.name);
  const toLine = to.length > 12 ? `${to.slice(0, 12).join(", ")} and ${to.length - 12} more` : to.join(", ");
  const header = [
    `From: ${from}${m.sender?.hint ? ` (${m.sender.hint})` : ""}`,
    toLine ? `To: ${toLine}` : null,
    `Subject: ${thread.subject}`,
    thread.institution ? `Institution: ${thread.institution}` : null,
    thread.children.length ? `About: ${thread.children.join(", ")}` : null,
    m.at ? `Sent: ${m.at.toISOString()}` : null,
    m.attachments.length ? `Attachments: ${m.attachments.join(", ")}` : null,
  ].filter(Boolean).join("\n");
  const text = `${header}\n\n${m.text}`.trim();
  return {
    externalId: messageExternalId(m.id), kind: "email", title: thread.subject, mime: "text/plain", text, sensitive: false,
    documentDate: m.at, precision: m.at ? "minute" : null, url: links.thread(thread.id), threadKey: threadKeyOf(thread.id),
    meta: {
      kind: "email", docKind: "mail", originalName: `Aula: ${thread.subject}`.slice(0, 250), correspondentsDone: true,
      email: { from, to: toLine || null, subject: thread.subject, messageId: messageExternalId(m.id) },
      aula: {
        threadId: thread.id, messageId: m.id, sender: m.sender ? { name: m.sender.name, role: roleWord[m.sender.role], hint: m.sender.hint } : null,
        recipients: to.slice(0, 60), institution: thread.institution, children: thread.children, attachments: m.attachments,
      },
    },
    fingerprint: fingerprint([m.id, m.text, m.at?.toISOString() ?? null]),
  };
}

export const SENSITIVE_TITLE = "Sensitive, open in Aula";

/** A sensitive thread: a placeholder that only says where to read it. No subject text, no message text, never read. */
export function sensitiveSource(thread: AulaThread, web: string): SourceDraft {
  return {
    externalId: `aula:sensitive:${thread.id}`, kind: "email", title: SENSITIVE_TITLE, mime: "text/plain", text: null, sensitive: true,
    documentDate: thread.latestAt, precision: thread.latestAt ? "minute" : null, url: aulaLinks(web).thread(thread.id), threadKey: threadKeyOf(thread.id),
    meta: {
      kind: "email", docKind: "mail", originalName: SENSITIVE_TITLE, correspondentsDone: true, noRead: true,
      // Shown in the reader's language ("Følsom besked – åbn den i Aula"); the English stays in the title.
      ...sourceTitleKey("aulaSensitive"),
      email: { from: thread.creator?.name ?? null, subject: SENSITIVE_TITLE, messageId: `aula:sensitive:${thread.id}` },
      aula: { threadId: thread.id, sensitive: true, institution: thread.institution, children: thread.children },
    },
    fingerprint: fingerprint([thread.id, thread.latestAt?.toISOString() ?? null, "sensitive"]),
  };
}

/* ── Posts ────────────────────────────────────────────────────────────────────────────────────────────── */

export type AulaPost = { id: string; title: string; text: string; at: Date | null; author: AulaProfile | null; institution: string | null; important: boolean; importantTo: Date | null; attachments: string[] };

export function postOf(raw: unknown): AulaPost | null {
  const p = obj(raw);
  const id = idOf(p.id);
  if (!id) return null;
  const owner = obj(p.ownerProfile);
  return {
    id, title: str(p.title, 250) ?? "(untitled post)",
    text: htmlToText(str(obj(p.content).html, 200_000) ?? (typeof p.content === "string" ? p.content : "")).slice(0, 100_000),
    at: aulaDate(p.publishAt ?? p.timestamp ?? p.createdAt), author: profileOf(owner),
    institution: str(obj(owner.institution).institutionName ?? owner.institutionName, 200),
    important: p.isImportant === true, importantTo: aulaDate(p.importantTo),
    attachments: arr(p.attachments).map((a) => str(obj(obj(a).file).name ?? obj(a).name, 200)).filter((x): x is string => !!x).slice(0, 30),
  };
}

export function postSource(p: AulaPost, web: string): SourceDraft {
  const header = [
    p.author ? `From: ${p.author.name}${p.author.hint ? ` (${p.author.hint})` : ""}` : null,
    p.institution ? `Institution: ${p.institution}` : null,
    p.at ? `Posted: ${p.at.toISOString()}` : null,
    p.important ? `Marked important${p.importantTo ? ` until ${p.importantTo.toISOString().slice(0, 10)}` : ""}` : null,
    p.attachments.length ? `Attachments: ${p.attachments.join(", ")}` : null,
  ].filter(Boolean).join("\n");
  return {
    externalId: `aula:post:${p.id}`, kind: "connector", title: p.title, mime: "text/plain", text: `${p.title}\n${header}\n\n${p.text}`.trim(), sensitive: false,
    documentDate: p.at, precision: p.at ? "minute" : null, url: aulaLinks(web).post(p.id), threadKey: null,
    meta: { kind: "aula_post", docKind: "note", originalName: `Aula post: ${p.title}`.slice(0, 250), aula: { postId: p.id, author: p.author?.name ?? null, institution: p.institution, important: p.important } },
    fingerprint: fingerprint([p.id, p.title, p.text, p.at?.toISOString() ?? null]),
  };
}

/* ── Calendar ─────────────────────────────────────────────────────────────────────────────────────────── */

export type AulaEvent = {
  id: string; title: string; type: string; start: Date; end: Date | null; allDay: boolean; location: string | null;
  profileIds: number[]; responseRequired: boolean; responseDeadline: Date | null; description: string; cancelled: boolean;
};

/** Lessons are the timetable, not family dates: they are left out. */
export function eventOf(raw: unknown): AulaEvent | null {
  const e = obj(raw);
  const id = idOf(e.id);
  const start = aulaDate(e.startDateTime ?? e.startDate);
  const type = (str(e.type, 60) ?? "event").toLowerCase();
  if (!id || !start || type === "lesson") return null;
  return {
    id, title: str(e.title, 250) ?? "Aula event", type, start, end: aulaDate(e.endDateTime ?? e.endDate), allDay: e.allDay === true,
    location: str(obj(e.primaryResource).name ?? e.primaryResourceText ?? e.location, 200),
    profileIds: arr(e.belongsToProfiles).map(numId).filter((x): x is number => !!x),
    responseRequired: e.responseRequired === true, responseDeadline: aulaDate(e.responseDeadline),
    description: htmlToText(str(obj(e.description).html, 20_000) ?? (typeof e.description === "string" ? e.description : "")).slice(0, 4000),
    cancelled: e.isCancelled === true || /cancel|aflyst/i.test(str(e.status, 40) ?? ""),
  };
}

export function eventSource(e: AulaEvent, web: string, childNames: string[]): SourceDraft {
  const text = [
    e.title,
    `When: ${e.start.toISOString()}${e.end ? ` to ${e.end.toISOString()}` : ""}`,
    e.location ? `Where: ${e.location}` : null,
    childNames.length ? `For: ${childNames.join(", ")}` : null,
    e.responseDeadline ? `Reply by: ${e.responseDeadline.toISOString()}` : null,
    e.description || null,
  ].filter(Boolean).join("\n");
  return {
    externalId: `aula:event:${e.id}`, kind: "connector", title: e.title, mime: "text/plain", text, sensitive: false,
    documentDate: e.start, precision: e.allDay ? "day" : "minute", url: aulaLinks(web).event(e.id), threadKey: null,
    // Proposed directly from Aula's own fields (eventOps), so the reading queue doesn't read it a second time.
    meta: { kind: "calendar_event", docKind: "note", noRead: true, aula: { eventId: e.id, type: e.type, children: childNames, responseDeadline: e.responseDeadline?.toISOString() ?? null }, cancelled: e.cancelled },
    fingerprint: fingerprint([e.id, e.title, e.start.toISOString(), e.end?.toISOString() ?? null, e.location, e.responseDeadline?.toISOString() ?? null, e.cancelled, e.description]),
  };
}

/** The proposed event (new or changed) with its children and a reminder to reply when Aula asks for an answer. */
export function eventOps(i: {
  e: AulaEvent; sourceId: string; nodeId: string; nodeExists: boolean; changed: boolean; childNodeIds: string[];
  visibility: "private" | "parents" | "household"; now: Date; relations: ReadonlySet<string>; url: string | null; kinds: ReadonlySet<string>;
}): ChangeInput[] {
  const { e } = i;
  const receipt: Receipt = { sourceId: i.sourceId, quote: `${e.title}${e.location ? `, ${e.location}` : ""}`, locator: { aula: { eventId: e.id } }, confidence: 1, ...(i.url ? { url: i.url } : {}) };
  if (e.cancelled) return i.nodeExists ? [{ op: "retireNode", nodeId: i.nodeId, note: "Cancelled in Aula.", receipt }] : [];
  const props = { aulaEventId: e.id, aulaType: e.type, ...(e.location ? { location: e.location } : {}), ...(e.allDay ? { allDay: true } : {}), ...(i.url ? { url: i.url } : {}) };
  const ops: ChangeInput[] = [];
  if (i.nodeExists) {
    if (i.changed) ops.push({ op: "updateNode", nodeId: i.nodeId, set: { label: e.title, startAt: e.start.toISOString(), endAt: e.end?.toISOString() ?? null, props }, note: "Changed in Aula.", receipt });
  } else {
    ops.push({
      op: "addNode", nodeId: i.nodeId, type: "event", kind: i.kinds.has("event:school_event") ? "school_event" : null, label: e.title,
      summary: e.description ? e.description.slice(0, 400) : undefined, props, startAt: e.start.toISOString(), endAt: e.end?.toISOString() ?? null,
      visibility: i.visibility, note: "From the Aula calendar.", receipt,
    });
    if (i.relations.has("involves")) for (const c of i.childNodeIds) ops.push({ op: "addEdge", fromId: i.nodeId, toId: c, relation: "involves", status: "confirmed", confidence: 1, note: "Aula lists it in their calendar.", receipt });
  }
  if (e.responseDeadline && e.responseDeadline.getTime() > i.now.getTime() && (!i.nodeExists || i.changed)) {
    const dayBefore = new Date(e.responseDeadline.getTime() - 24 * 3600_000);
    ops.push({
      op: "addReminder", title: `Reply in Aula: ${e.title}`, dueAt: (dayBefore.getTime() > i.now.getTime() ? dayBefore : i.now).toISOString(),
      aboutNodeId: i.childNodeIds[0] ?? null, detail: `Aula asks for an answer by ${e.responseDeadline.toISOString().slice(0, 16).replace("T", " ")} UTC.`,
      note: "So the reply deadline isn't missed.", receipt,
    });
  }
  return ops;
}

/* ── Presence (komme/gå) ──────────────────────────────────────────────────────────────────────────────── */

const PRESENCE: Record<number, string | null> = { 0: null, 1: "sick", 2: "away today", 3: "arrived", 4: "on a trip", 5: null, 6: null, 7: null, 8: "gone home" };

/** "HH:mm" or a full time → "HH:mm". */
const hhmm = (v: unknown): string | null => {
  const s = str(v, 40);
  if (!s) return null;
  const m = s.match(/(\d{1,2}):(\d{2})/);
  return m ? `${m[1].padStart(2, "0")}:${m[2]}` : null;
};

/** One child's day in Aula's presence overview → a dated item, or null when there is nothing worth a mark. */
export function presenceSource(raw: unknown, child: { id: number; name: string }, day: string, web: string): SourceDraft | null {
  const p = obj(raw);
  const status = Number(p.status);
  const word = Number.isInteger(status) ? PRESENCE[status] ?? null : null;
  const exitTime = hhmm(p.exitTime), exitWith = str(p.exitWith, 120), checkOut = hhmm(p.checkOutTime), checkIn = hhmm(p.checkInTime);
  const parts: string[] = [];
  if (word === "sick" || word === "away today" || word === "on a trip") parts.push(word);
  if (word === "gone home" && checkOut) parts.push(`went home at ${checkOut}${exitWith ? ` with ${exitWith}` : ""}`);
  else if (exitTime || exitWith) parts.push(`pick-up${exitTime ? ` at ${exitTime}` : ""}${exitWith ? ` by ${exitWith}` : ""}`);
  if (!parts.length) return null;
  const comment = str(p.comment, 500);
  const title = `${child.name}: ${parts.join(", ")}`;
  // Times are Copenhagen wall-clock and stay in the text; the mark is on the day (noon UTC, precision day).
  return {
    externalId: `aula:presence:${child.id}:${day}`, kind: "connector", title, mime: "text/plain",
    text: [title, checkIn ? `Arrived ${checkIn}` : null, comment ? `Note: ${comment}` : null].filter(Boolean).join("\n"), sensitive: word === "sick",
    documentDate: new Date(`${day}T12:00:00Z`), precision: "day", url: aulaLinks(web).presence(), threadKey: null,
    meta: { kind: "aula_presence", docKind: "note", noRead: true, aula: { childId: child.id, child: child.name, day, status, exitTime, exitWith, checkIn, checkOut } },
    fingerprint: fingerprint([status, exitTime, exitWith, checkIn, checkOut, comment]),
  };
}

/* ── Gallery: links only ──────────────────────────────────────────────────────────────────────────────── */

export type AulaAlbum = { id: string; title: string; at: Date | null; count: number | null; creator: string | null };

export function albumsFrom(data: unknown): AulaAlbum[] {
  const list = Array.isArray(data) ? data : arr(obj(data).albums);
  return list.flatMap((raw) => {
    const a = obj(raw);
    const id = idOf(a.id);
    if (!id) return [];
    return [{ id, title: str(a.title ?? a.name, 250) ?? "Album", at: aulaDate(a.creationDate ?? a.createdAt ?? a.updatedAt), count: Number.isFinite(Number(a.size ?? a.mediaCount ?? a.totalSize)) ? Number(a.size ?? a.mediaCount ?? a.totalSize) : null, creator: str(obj(a.creator).name ?? obj(a.creator).fullName, 160) }];
  });
}

/** Media ids in an album (only the ids: pictures and their short-lived addresses are never stored). */
export function mediaIdsFrom(data: unknown): string[] {
  const list = Array.isArray(data) ? data : arr(obj(data).results ?? obj(data).media ?? obj(data).mediaList);
  return list.map((m) => idOf(obj(m).id)).filter((x): x is string => !!x).slice(0, 500);
}

export function albumSource(a: AulaAlbum, web: string, mediaIds: string[]): SourceDraft {
  const links = aulaLinks(web);
  const count = a.count ?? (mediaIds.length || null);
  return {
    externalId: `aula:album:${a.id}`, kind: "connector", title: a.title, mime: "text/uri-list",
    text: `${a.title}\n${count ? `${count} pictures in Aula` : "Pictures in Aula"}${a.creator ? `, shared by ${a.creator}` : ""}.\nOpen in Aula: ${links.album(a.id)}`, sensitive: false,
    documentDate: a.at, precision: a.at ? "day" : null, url: links.album(a.id), threadKey: null,
    meta: { kind: "aula_album", docKind: "note", noRead: true, linkOnly: true, aula: { albumId: a.id, count, creator: a.creator, media: mediaIds.slice(0, 200).map((m) => links.media(a.id, m)) } },
    fingerprint: fingerprint([a.id, a.title, count]),
  };
}

/* ── People ───────────────────────────────────────────────────────────────────────────────────────────── */

export type KnownNode = { id: string; type: string; label: string; aliases: string[]; kind?: string | null };

/** A person seen in Aula, with where (the receipt points at a stored source). */
export type SeenPerson = AulaProfile & { institution: string | null; children: string[]; sourceExternalId: string; quote: string; locator: Record<string, unknown> };

export type PeopleMapping = Record<string, { nodeId: string; at: string }>;

/** A mapped person whose proposal nobody decided on in this long is proposed again. */
export const REPROPOSE_AFTER_MS = 30 * 24 * 3600_000;

/** A child's Aula name ("Emma Louise Hansen") against the graph's people ("Emma", "Emma Hansen"). */
export function matchPerson(name: string, people: KnownNode[]): KnownNode | undefined {
  const exact = matchKnownPerson(name, people);
  if (exact) return people.find((p) => p.id === exact.id);
  const parts = norm(name).split(" ");
  const first = parts[0];
  const last = parts.length > 1 ? parts[parts.length - 1] : null;
  const firstLast = last ? people.filter((p) => { const l = norm(p.label).split(" "); return l[0] === first && l[l.length - 1] === last; }) : [];
  if (firstLast.length === 1) return firstLast[0];
  const byFirst = people.filter((p) => norm(p.label) === first || p.aliases.some((a) => norm(a) === first));
  return byFirst.length === 1 ? byFirst[0] : undefined;
}

export function institutionKind(name: string): "school" | "daycare" {
  return /skole|school|gymnasi|efterskole/i.test(name) && !/sfo|fritid/i.test(name) ? "school" : "daycare";
}

/** The role a staff member's Aula title names: class teacher, teacher, pedagogue or principal. */
export function staffRole(hint: string | null): string | null {
  const hit = detectRole(hint);
  if (hit && ["class_teacher", "teacher", "pedagogue", "school_leader"].includes(hit.role)) return hit.role;
  return staffKind(hint);
}

export function staffKind(hint: string | null): "teacher" | "pedagogue" | "school_leader" | null {
  const h = (hint ?? "").toLowerCase();
  if (/leder|leader|inspektør|principal/.test(h)) return "school_leader";
  if (/pædagog|paedagog|pedagog/.test(h)) return "pedagogue";
  if (/lærer|laerer|teacher|klasselærer|kontaktlærer/.test(h)) return "teacher";
  return null;
}

export type PeopleInput = {
  account: AulaAccount;
  seen: SeenPerson[];
  known: KnownNode[];
  mapping: PeopleMapping;
  /** Mapped node ids that exist in the graph now (delivered proposals, or people matched earlier). */
  existing: ReadonlySet<string>;
  existingEdges: ReadonlySet<string>;
  sourceIdFor: (externalId: string) => string | undefined;
  /** The account's own source for receipts about the children (any stored Aula item). */
  accountSourceId: string | undefined;
  relations: ReadonlySet<string>;
  kinds: ReadonlySet<string>;
  visibility: "private" | "parents" | "household";
  now: Date;
  mint: () => string;
  /** The signed-in parent's own person node, when the graph has one (for "parent of" their children). */
  selfNodeId?: string | null;
};

export type PeopleResult = { changes: ChangeInput[]; mapping: PeopleMapping; childNodes: Map<number, string>; counts: { people: number; places: number; connections: number } };

export const edgeKey = (from: string, relation: string, to: string) => `${from}|${relation}|${to}`;

/**
 * Children, their institutions, and the staff and parents who wrote, as proposed changes. A person already in the
 * graph is matched (by name, or by what this connection matched before) and never proposed twice; a proposal waiting
 * for someone is not repeated for 30 days. Plain recipients of class-wide threads are not proposed (too many).
 */
export function peopleOps(i: PeopleInput): PeopleResult {
  const changes: ChangeInput[] = [];
  const mapping: PeopleMapping = { ...i.mapping };
  const people = i.known.filter((k) => k.type === "person");
  const places = i.known.filter((k) => k.type === "place");
  const edges = new Set(i.existingEdges);
  const counts = { people: 0, places: 0, connections: 0 };
  const childNodes = new Map<number, string>();
  const at = i.now.toISOString();
  const selfName = i.account.name ? norm(i.account.name) : null;

  /** Nodes proposed by an earlier run and still waiting: their connections went into that same proposal. */
  const waiting = new Set<string>();
  /** The node for an Aula key: mapped (exists, or waiting less than 30 days), matched by name, or null. */
  const resolve = (key: string, name: string, pool: KnownNode[]): { id: string; pending: boolean } | null => {
    const m = mapping[key];
    if (m && i.existing.has(m.nodeId)) return { id: m.nodeId, pending: false };
    if (m && i.now.getTime() - Date.parse(m.at) < REPROPOSE_AFTER_MS) { waiting.add(m.nodeId); return { id: m.nodeId, pending: true }; }
    const hit = pool === people ? matchPerson(name, pool) : pool.find((p) => norm(p.label) === norm(name) || p.aliases.some((a) => norm(a) === norm(name)));
    if (hit) { mapping[key] = { nodeId: hit.id, at }; return { id: hit.id, pending: false }; }
    return null;
  };
  const edge = (fromId: string, relation: string, toId: string, receipt: Receipt, confidence: number, status: "confirmed" | "unconfirmed", note: string) => {
    if (!i.relations.has(relation) || fromId === toId || waiting.has(fromId) || waiting.has(toId)) return;
    const k = edgeKey(fromId, relation, toId);
    if (edges.has(k)) return;
    edges.add(k);
    // A connection someone declined (or hasn't decided on yet) isn't proposed again for 30 days.
    const prev = mapping[`edge:${k}`];
    if (prev && i.now.getTime() - Date.parse(prev.at) < REPROPOSE_AFTER_MS) return;
    mapping[`edge:${k}`] = { nodeId: "", at };
    changes.push({ op: "addEdge", fromId, toId, relation, confidence, status, note, receipt });
    counts.connections++;
  };
  const kindIf = (type: string, kind: string | null) => (kind && i.kinds.has(`${type}:${kind}`) ? kind : null);
  /** A role held (src/lib/meta/roles.ts): staff at the institution, a classmate, a classmate's parent. No context → back at the person. */
  const roleEdge = (personId: string, role: string, contextId: string | null, receipt: Receipt, confidence: number, note: string) => {
    if (waiting.has(personId) || (contextId && waiting.has(contextId))) return;
    const relation = roleRelation(role), toId = contextId ?? personId;
    const k = edgeKey(personId, relation, toId);
    if (edges.has(k)) return;
    edges.add(k);
    const prev = mapping[`edge:${k}`];
    if (prev && i.now.getTime() - Date.parse(prev.at) < REPROPOSE_AFTER_MS) return;
    mapping[`edge:${k}`] = { nodeId: "", at };
    changes.push({ op: "addEdge", fromId: personId, toId, relation, confidence, status: confidence >= 0.8 ? "confirmed" : "unconfirmed", note, receipt });
    counts.connections++;
  };
  const instByName = new Map<string, string>();

  // Children and where they go.
  const accountReceipt: Receipt = { sourceId: i.accountSourceId, quote: "Aula: the children on this parent's login", locator: { aula: { profiles: true } }, confidence: 1 };
  for (const c of i.account.children) {
    const key = `child:${c.id}`;
    let r = resolve(key, c.name, people);
    if (!r) {
      const id = i.mint();
      changes.push({ op: "addNode", nodeId: id, type: "person", kind: kindIf("person", "child"), label: c.name, props: { aulaChild: true }, visibility: i.visibility, note: "A child on your Aula login.", receipt: accountReceipt });
      mapping[key] = { nodeId: id, at };
      counts.people++;
      r = { id, pending: false };
    }
    childNodes.set(c.id, r.id);
    if (i.selfNodeId) edge(i.selfNodeId, "parent_of", r.id, { ...accountReceipt, quote: `${i.account.name ?? "This parent"}: ${c.name}` }, 1, "confirmed", "Aula lists them as your child.");
    if (c.institutionName) {
      const ikey = `inst:${c.institutionCode ?? norm(c.institutionName)}`;
      let inst = resolve(ikey, c.institutionName, places);
      if (!inst) {
        const id = i.mint();
        changes.push({ op: "addNode", nodeId: id, type: "place", kind: kindIf("place", institutionKind(c.institutionName)), label: c.institutionName, props: c.institutionCode ? { aulaInstitutionCode: c.institutionCode } : {}, visibility: i.visibility, note: "A school or daycare on your Aula login.", receipt: { ...accountReceipt, quote: `${c.name}, ${c.institutionName}` } });
        mapping[ikey] = { nodeId: id, at };
        counts.places++;
        inst = { id, pending: false };
      }
      instByName.set(norm(c.institutionName), inst.id);
      edge(r.id, "attends", inst.id, { ...accountReceipt, quote: `${c.name}, ${c.institutionName}` }, 1, "confirmed", "Aula lists the child at this institution.");
    }
  }

  // People who wrote (senders, thread creators, post authors).
  const childByName = new Map(i.account.children.map((c) => [norm(c.name), childNodes.get(c.id)!]));
  const done = new Set<string>();
  for (const p of i.seen) {
    if (done.has(p.key) || (selfName && norm(p.name) === selfName)) continue;
    if (i.account.children.some((c) => norm(c.name) === norm(p.name))) continue;
    done.add(p.key);
    const sourceId = i.sourceIdFor(p.sourceExternalId);
    if (!sourceId) continue; // every proposal has a receipt pointing at a stored source
    const receipt: Receipt = { sourceId, quote: p.quote.slice(0, 200), locator: p.locator, confidence: 0.9 };
    let r = resolve(p.key, p.name, people);
    // What they are to us is a role, not a kind: staff at the school, a classmate, a classmate's parent.
    const role = p.role === "staff" ? (staffRole(p.hint) ?? "teacher") : p.role === "guardian" ? "childs_friend_parent" : p.role === "child" ? "classmate" : null;
    if (!r) {
      const id = i.mint();
      changes.push({
        op: "addNode", nodeId: id, type: "person", kind: null, label: p.name,
        props: { aulaRole: roleWord[p.role], ...(p.hint ? { aulaTitle: p.hint } : {}), ...(p.institution ? { institution: p.institution } : {}) },
        visibility: i.visibility, note: p.role === "staff" ? "Writes to you in Aula from school or daycare." : "Writes to you in Aula.", receipt,
      });
      mapping[p.key] = { nodeId: id, at };
      counts.people++;
      r = { id, pending: false };
    }
    if (role && !r.pending) {
      const inst = p.institution ? instByName.get(norm(p.institution)) ?? null : null;
      roleEdge(r.id, role, inst, receipt, p.role === "staff" ? 0.9 : 0.6, p.role === "staff" ? `Writes in Aula as ${p.hint ?? "staff"}.` : "Writes to you in Aula.");
    }
    if (p.role === "staff" && staffKind(p.hint) !== "school_leader") {
      for (const name of p.children) {
        const cid = childByName.get(norm(name));
        if (cid) edge(r.id, "teacher_of", cid, receipt, 0.6, "unconfirmed", `Wrote about ${name} in Aula.`);
      }
    }
  }
  return { changes, mapping, childNodes, counts };
}
