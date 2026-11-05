/**
 * What Famly's answers become in My Graph (pure: no DB, no network).
 *
 * Famly (app.famly.co) has no API for parents; this follows the parent web app's own calls as open-source tools use
 * them (jacobbunk/famly-fetch: api_client.py, image.py and its GraphQL files; nrbrook/famly-downloader api.md):
 *
 *   login          POST /graphql  mutation Authenticate → me.authenticateWithPassword { accessToken } (or Failed /
 *                  Challenged); later calls send it as the `x-famly-accesstoken` header.
 *   children       GET /api/me/me/me → roles2: [{ targetId, title }]                                       (known)
 *   feed           GET /api/feed/feed/feed?first=&olderThan=&cursor= → feedItems: [{ feedItemId, originatorId
 *                  ("Post:…", "Event:…" …), createdDate, body, sender: { name }, images: [{ imageId, prefix, key }],
 *                  files: [{ url, filename }] }]                                                              (known)
 *   daily notes    POST /graphql GetChildNotes → childNotes { next, result: [{ text, createdAt, createdBy { name {
 *                  fullName } }, images: [{ id, secret { prefix, key, path, expires } }] }] }                  (known)
 *   messages       GET /api/v2/conversations → [{ conversationId, title?, lastActivityAt, participants }];
 *                  GET /api/v2/conversations/<id> → { messages: [{ messageId, createdAt, body, author { title },
 *                  images }] }                                                                                 (known)
 *   calendar       Famly's own calendar endpoints are not documented by any open tool we know of. Events are taken
 *                  from feed items whose originatorId starts with "Event:" when they carry a start time (embed.from /
 *                  embed.startDate …). This part is a GUESS at the shape and is read very tolerantly.
 *
 * Every field is read tolerantly (a missing or renamed field is skipped, never fatal). What Famly says is data,
 * never instructions.
 */
import { createHash } from "node:crypto";
import type { ChangeInput } from "@/lib/changes";
import type { IcsEvent } from "../ics/parse";

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw => (v && typeof v === "object" && !Array.isArray(v) ? (v as Raw) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown, max = 2000): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : typeof v === "number" ? String(v) : null);
const idOf = (v: unknown): string | null => {
  const s = str(v, 200);
  return s && /^[A-Za-z0-9_.:-]+$/.test(s) ? s : null;
};

export const fingerprint = (x: unknown) => createHash("sha256").update(JSON.stringify(x)).digest("hex").slice(0, 24);

export const FAMLY_BASE = "https://app.famly.co";

/** "2026-11-03T14:05:00+00:00", "2026-11-03 14:05:00" or { date: "…" } → a Date. */
export function famlyDate(v: unknown): Date | null {
  const s = str(typeof v === "object" && v ? obj(v).date ?? obj(v).datetime : v, 60);
  if (!s) return null;
  let t = s.replace(" ", "T");
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) t += "T00:00:00Z";
  else if (/T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(t)) t += "Z";
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d;
}

/* ── Sign-in ──────────────────────────────────────────────────────────────────────────────────────────── */

export const AUTHENTICATE = `mutation Authenticate($email: EmailAddress!, $password: Password!, $deviceId: DeviceId, $legacy: Boolean) {
  me { authenticateWithPassword(email: $email, password: $password, deviceId: $deviceId, legacy: $legacy) {
    status __typename
    ... on AuthenticationFailed { status errorDetails errorTitle __typename }
    ... on AuthenticationSucceeded { accessToken deviceId __typename }
    ... on AuthenticationChallenged { loginId deviceId expiresAt __typename }
  } __typename }
}`;

export type LoginResult = { kind: "ok"; accessToken: string } | { kind: "failed"; message: string } | { kind: "challenged" } | { kind: "unknown" };

export function loginResult(body: unknown): LoginResult {
  const r = obj(obj(obj(obj(body).data).me).authenticateWithPassword);
  const type = str(r.__typename, 60);
  const token = str(r.accessToken, 4000);
  if (token) return { kind: "ok", accessToken: token };
  if (type === "AuthenticationChallenged") return { kind: "challenged" };
  if (type === "AuthenticationFailed" || r.errorTitle || r.errorDetails) return { kind: "failed", message: str(r.errorDetails ?? r.errorTitle, 200) ?? "Famly refused the email or password." };
  if (arr(obj(body).errors).length) return { kind: "failed", message: str(obj(arr(obj(body).errors)[0]).message, 200) ?? "Famly refused the sign-in." };
  return { kind: "unknown" };
}

export const CHILD_NOTES = `query GetChildNotes($childId: ChildId!, $cursor: ChildNoteCursor, $limit: Int!, $parentVisible: Boolean, $safeguardingConcern: Boolean, $sensitive: Boolean, $noteTypes: [ChildNoteType!]) {
  childNotes(childIds: [$childId], cursor: $cursor, limit: $limit, parentVisible: $parentVisible, safeguardingConcern: $safeguardingConcern, sensitive: $sensitive, noteTypes: $noteTypes) {
    next
    result { id noteType createdBy { name { fullName } } text createdAt publishedAt images { height id secret { crop expires key path prefix } width } files { fileId: id url filename: name } }
  }
}`;

/* ── Children ─────────────────────────────────────────────────────────────────────────────────────────── */

export type FamlyChild = { id: string; name: string };

/** /api/me/me/me → the children this login is a parent of (roles2: targetId + title). */
export function childrenFrom(me: unknown): FamlyChild[] {
  const out: FamlyChild[] = [];
  for (const r of arr(obj(me).roles2)) {
    const role = obj(r);
    const id = idOf(role.targetId);
    const name = str(role.title, 160);
    const type = str(role.targetType ?? role.type, 60)?.toLowerCase() ?? "";
    if (!id || !name || (type && !type.includes("child"))) continue;
    if (!out.some((c) => c.id === id)) out.push({ id, name });
  }
  return out;
}

/* ── Pictures and files ───────────────────────────────────────────────────────────────────────────────── */

export type FamlyImage = { id: string; url: string; width: number | null; height: number | null };
export type FamlyFile = { id: string; url: string; name: string };

const https = (u: string | null): string | null => {
  if (!u) return null;
  try { const x = new URL(u); return x.protocol === "https:" ? x.toString() : null; } catch { return null; }
};

/** Feed / message images ({ imageId, prefix, key }) and note images ({ id, secret: { prefix, key, path, expires } }). */
export function imagesFrom(list: unknown): FamlyImage[] {
  const out: FamlyImage[] = [];
  for (const raw of arr(list)) {
    const i = obj(raw);
    const secret = obj(i.secret);
    const id = idOf(i.imageId ?? i.id);
    let url: string | null = null;
    if (str(secret.prefix) && str(secret.key)) {
      url = `${str(secret.prefix)}/${str(secret.key)}${str(secret.path) ? `/${str(secret.path)}` : ""}${str(secret.expires) ? `?expires=${encodeURIComponent(str(secret.expires)!)}` : ""}`;
    } else if (str(i.prefix) && str(i.key)) {
      url = `${str(i.prefix)}/${str(i.key)}`;
    } else {
      url = str(i.url_big ?? i.url, 2000);
    }
    const safe = https(url);
    if (!id || !safe) continue;
    out.push({ id, url: safe, width: Number(i.width) || null, height: Number(i.height) || null });
  }
  return out;
}

export function filesFrom(list: unknown): FamlyFile[] {
  const out: FamlyFile[] = [];
  for (const raw of arr(list)) {
    const f = obj(raw);
    const url = https(str(f.url, 2000));
    const id = idOf(f.fileId ?? f.id) ?? (url ? fingerprint(url) : null);
    if (!url || !id) continue;
    out.push({ id, url, name: (str(f.filename ?? f.name, 200) ?? "file").replace(/[\\/]/g, "_") });
  }
  return out;
}

/* ── Feed, notes and messages as sources ──────────────────────────────────────────────────────────────── */

export type FamlyDraft = {
  externalId: string;
  kind: "connector" | "email";
  title: string;
  text: string;
  at: Date | null;
  url: string;
  threadKey: string | null;
  images: FamlyImage[];
  files: FamlyFile[];
  meta: Record<string, unknown>;
  fingerprint: string;
};

export type FeedItem = {
  id: string; originator: string; at: Date | null; body: string; sender: string | null; images: FamlyImage[]; files: FamlyFile[];
  event: { title: string; start: Date; end: Date | null; allDay: boolean; location: string | null } | null;
};

export function feedItemOf(raw: unknown): FeedItem | null {
  const f = obj(raw);
  const id = idOf(f.feedItemId ?? f.id);
  if (!id) return null;
  const originator = str(f.originatorId, 200) ?? "";
  const body = str(f.body ?? f.text, 50_000) ?? "";
  const embed = obj(f.embed);
  let event: FeedItem["event"] = null;
  if (/^event:/i.test(originator) || /event/i.test(str(embed.type, 40) ?? "")) {
    const start = famlyDate(embed.from ?? embed.startDate ?? embed.start ?? f.from ?? f.startDate);
    if (start) {
      const end = famlyDate(embed.to ?? embed.endDate ?? embed.end ?? f.to ?? f.endDate);
      const allDay = embed.allDay === true || embed.isAllDay === true || (/T00:00:00/.test(start.toISOString()) && (!end || /T00:00:00/.test(end.toISOString())));
      event = { title: str(embed.title ?? f.title, 300) ?? body.split("\n")[0].slice(0, 200) ?? "Famly event", start, end, allDay, location: str(embed.location ?? embed.place, 300) };
    }
  }
  return {
    id, originator, at: famlyDate(f.createdDate ?? f.createdAt), body, sender: str(obj(f.sender).name ?? obj(f.sender).title ?? f.senderName, 160),
    images: imagesFrom(f.images), files: filesFrom(f.files), event,
  };
}

const firstLine = (t: string, fallback: string) => (t.split("\n").map((l) => l.trim()).find(Boolean) ?? fallback).slice(0, 120);

export function feedSource(p: FeedItem, childNames: string[]): FamlyDraft {
  const header = [p.sender ? `From: ${p.sender}` : null, p.at ? `Date: ${p.at.toISOString()}` : null, childNames.length ? `Children: ${childNames.join(", ")}` : null].filter(Boolean).join("\n");
  return {
    externalId: `famly:feed:${p.id}`, kind: "connector", title: firstLine(p.body, p.sender ? `Famly post from ${p.sender}` : "Famly post"),
    text: `${header}\n\n${p.body}`.trim(), at: p.at, url: `${FAMLY_BASE}/#/account/feed`, threadKey: null, images: p.images, files: p.files,
    meta: { kind: "famly_post", docKind: "note", famly: { feedItemId: p.id, originator: p.originator, sender: p.sender, images: p.images.length } },
    fingerprint: fingerprint([p.body, p.sender, p.images.map((i) => i.id), p.files.map((f) => f.id)]),
  };
}

export type ChildNote = { id: string; at: Date | null; author: string | null; text: string; images: FamlyImage[]; files: FamlyFile[]; type: string | null };

export function notesFrom(data: unknown): { notes: ChildNote[]; next: string | null } {
  const cn = obj(obj(data).childNotes);
  const notes: ChildNote[] = [];
  for (const raw of arr(cn.result)) {
    const n = obj(raw);
    const text = str(n.text, 50_000) ?? "";
    const at = famlyDate(n.publishedAt ?? n.createdAt);
    const images = imagesFrom(n.images);
    if (!text && !images.length) continue;
    const id = idOf(n.id) ?? fingerprint([text, at?.toISOString() ?? null]);
    notes.push({ id, at, author: str(obj(obj(n.createdBy).name).fullName, 160), text, images, files: filesFrom(n.files), type: str(n.noteType, 40) });
  }
  return { notes, next: str(cn.next, 500) };
}

export function noteSource(n: ChildNote, child: FamlyChild): FamlyDraft {
  const header = [`Child: ${child.name}`, n.author ? `From: ${n.author}` : null, n.at ? `Date: ${n.at.toISOString()}` : null].filter(Boolean).join("\n");
  return {
    externalId: `famly:note:${child.id}:${n.id}`, kind: "connector", title: firstLine(n.text, `Note about ${child.name}`),
    text: `${header}\n\n${n.text}`.trim(), at: n.at, url: `${FAMLY_BASE}/#/account/childProfile/${encodeURIComponent(child.id)}`, threadKey: null,
    images: n.images, files: n.files,
    // Note images carry signed, expiring addresses: the id is what identifies them, not the address.
    meta: { kind: "famly_note", docKind: "note", famly: { noteId: n.id, child: child.name, childId: child.id, author: n.author, type: n.type } },
    fingerprint: fingerprint([n.text, n.author, n.images.map((i) => i.id)]),
  };
}

export type Conversation = { id: string; title: string | null; lastActivity: Date | null; participants: string[] };

export function conversationsFrom(data: unknown): Conversation[] {
  const out: Conversation[] = [];
  for (const raw of arr(data)) {
    const c = obj(raw);
    const id = idOf(c.conversationId ?? c.id);
    if (!id) continue;
    out.push({
      id, title: str(c.title ?? c.subject, 250), lastActivity: famlyDate(c.lastActivityAt ?? c.createdAt),
      participants: arr(c.participants).map((p) => str(obj(p).title ?? obj(p).name, 160)).filter((x): x is string => !!x),
    });
  }
  return out;
}

export type FamlyMessage = { id: string; at: Date | null; author: string | null; me: boolean; body: string; images: FamlyImage[]; files: FamlyFile[] };

export function messagesFrom(data: unknown): FamlyMessage[] {
  const out: FamlyMessage[] = [];
  for (const raw of arr(obj(data).messages)) {
    const m = obj(raw);
    const id = idOf(m.messageId ?? m.id);
    if (!id) continue;
    const a = obj(m.author);
    out.push({ id, at: famlyDate(m.createdAt), author: str(a.title ?? a.name, 160), me: a.me === true, body: str(m.body, 50_000) ?? "", images: imagesFrom(m.images), files: filesFrom(m.files) });
  }
  return out.sort((x, y) => (x.at?.getTime() ?? 0) - (y.at?.getTime() ?? 0));
}

export function messageSource(c: Conversation, m: FamlyMessage): FamlyDraft {
  const subject = c.title ?? (c.participants.length ? `Famly: ${c.participants.slice(0, 3).join(", ")}` : "Famly message");
  const header = [`From: ${m.author ?? "unknown"}`, c.participants.length ? `Conversation with: ${c.participants.join(", ")}` : null, m.at ? `Date: ${m.at.toISOString()}` : null].filter(Boolean).join("\n");
  return {
    externalId: `famly:msg:${m.id}`, kind: "email", title: subject.slice(0, 250), text: `${header}\n\n${m.body}`.trim(), at: m.at,
    url: `${FAMLY_BASE}/#/account/messages/${encodeURIComponent(c.id)}`, threadKey: `famly:conv:${c.id}`, images: m.images, files: m.files,
    meta: { kind: "email", docKind: "mail", originalName: `Famly: ${subject}`.slice(0, 250), correspondentsDone: true, famly: { conversationId: c.id, messageId: m.id, author: m.author, fromMe: m.me } },
    fingerprint: fingerprint([m.body, m.author, m.images.map((i) => i.id)]),
  };
}

/** Messages newer than what was stored for this conversation (by time; ids break ties). */
export function newMessages(list: FamlyMessage[], knownAt: string | undefined, since: Date): FamlyMessage[] {
  const floor = Math.max(knownAt ? Date.parse(knownAt) : 0, since.getTime());
  return list.filter((m) => !m.at || m.at.getTime() > floor);
}

/* ── Calendar items, in the calendar link's shape (so they are proposed like any calendar) ──────────── */

export function eventOf(p: FeedItem): IcsEvent | null {
  if (!p.event) return null;
  const e = p.event;
  const day = e.allDay ? new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Copenhagen" }).format(e.start) : null;
  return {
    key: `famly:${p.id}`, uid: `famly:${p.id}`, summary: e.title, description: p.body || null, location: e.location, url: `${FAMLY_BASE}/#/account/feed`,
    start: e.start, end: e.end, allDay: e.allDay, date: day, status: "confirmed", sequence: 0, lastModified: null, organizer: p.sender,
    categories: [], recurring: false, fingerprint: fingerprint([e.title, e.start.toISOString(), e.end?.toISOString() ?? null, e.location, p.body]),
  };
}

/* ── Children in the graph ────────────────────────────────────────────────────────────────────────────── */

export type KnownPerson = { id: string; label: string; aliases: string[]; kind?: string | null; props: Record<string, unknown> };

const norm = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, " ").replace(/\s+/g, " ").trim();

/**
 * Famly child → graph person: the one already tied to this Famly child (props.famlyChildId), else the person picked in
 * the form when Famly has just one child, else a unique full-name match, else a unique first-name match among children.
 */
export function matchChildren(children: FamlyChild[], people: KnownPerson[], picked: string | null): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of children) {
    const tied = people.find((p) => p.props.famlyChildId === c.id);
    if (tied) { out.set(c.id, tied.id); continue; }
    if (picked && children.length === 1 && people.some((p) => p.id === picked)) { out.set(c.id, picked); continue; }
    const full = people.filter((p) => [p.label, ...p.aliases].some((l) => norm(l) === norm(c.name)));
    if (full.length === 1) { out.set(c.id, full[0].id); continue; }
    const first = norm(c.name).split(" ")[0];
    const kids = people.filter((p) => (p.kind === "child" || p.props.aulaChild === true) && [p.label, ...p.aliases].some((l) => norm(l).split(" ")[0] === first));
    if (kids.length === 1) out.set(c.id, kids[0].id);
  }
  return out;
}

/** Children Famly knows that aren't in the graph: proposed as people, each with a receipt from the login's source. */
export function childOps(i: { children: FamlyChild[]; matched: Map<string, string>; proposed: Record<string, string>; sourceId: string; mint: () => string; childKind: boolean; visibility: "private" | "parents" | "household" }): { changes: ChangeInput[]; proposed: Record<string, string> } {
  const changes: ChangeInput[] = [];
  const proposed = { ...i.proposed };
  for (const c of i.children) {
    if (i.matched.has(c.id) || proposed[c.id]) continue;
    const id = i.mint();
    proposed[c.id] = id;
    changes.push({
      op: "addNode", nodeId: id, type: "person", kind: i.childKind ? "child" : null, label: c.name, props: { famlyChildId: c.id }, visibility: i.visibility,
      note: "A child on your Famly login.", receipt: { sourceId: i.sourceId, quote: `Child: ${c.name}`, locator: { famly: { childId: c.id } }, confidence: 1 },
    });
  }
  return { changes, proposed };
}
