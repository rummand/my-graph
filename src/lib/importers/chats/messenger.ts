/**
 * Importer `messenger`: Facebook Messenger and Instagram chats from Meta's "Download your information" (JSON), as the
 * whole zip or a single messages/inbox/<thread>/message_N.json. Also the newer end-to-end-encrypted Messenger
 * export (participants as names, `senderName`/`text`/`timestamp`). Pure.
 *
 * Meta writes UTF-8 text as if every byte were a Latin-1 character ("SÃ¸ren" for "Søren"); that is undone.
 * The person who downloaded it is the one in (nearly) every conversation, or named in profile_information.json.
 */
import type { Importer, ImportInput, ImportContext, ImportPlan } from "../types";
import { normName } from "../match";
import { baseName, chatPlan, decodeText, type ChatMessage, type ChatThread } from "./common";

/** Undo Meta's mojibake: UTF-8 bytes stored as one Latin-1 character each. Leaves correct text alone. */
export function fixMojibake(s: string): string {
  if (!/[\u0080-ÿ]/.test(s) || /[^\u0000-ÿ]/.test(s)) return s;
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return s; }
}

/** Thread files Meta writes (inbox, archived; not message requests or filtered spam). */
const THREAD_FILE = /(?:^|\/)messages\/(?:inbox|archived_threads|e2ee_cutover)\/([^/]+)\/message_\d+\.json$/;
const PROFILE_FILE = /(?:^|\/)profile_information\.json$/;

type Obj = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? fixMojibake(v) : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);

type RawThread = { key: string; title: string; participants: string[]; messages: ChatMessage[]; instagram: boolean };

const MEDIA_KEYS = ["photos", "videos", "audio_files", "files", "gifs", "media"] as const;

/** One message_N.json (classic or end-to-end-encrypted shape). */
export function parseThreadJson(json: unknown, key: string, instagram = false): RawThread | null {
  const o = obj(json);
  if (!o || !Array.isArray(o.messages)) return null;
  const participants = arr(o.participants).map((p) => (typeof p === "string" ? fixMojibake(p) : str(obj(p)?.name))).filter((x): x is string => !!x);
  const messages: ChatMessage[] = [];
  for (const raw of o.messages) {
    const m = obj(raw);
    if (!m || m.is_unsent === true || m.isUnsent === true) continue;
    const ms = typeof m.timestamp_ms === "number" ? m.timestamp_ms : typeof m.timestamp === "number" ? m.timestamp : null;
    if (ms === null) continue;
    const at = new Date(ms < 1e12 ? ms * 1000 : ms);
    if (Number.isNaN(at.getTime())) continue;
    const author = str(m.sender_name) ?? str(m.senderName);
    const text = str(m.content) ?? str(m.text) ?? "";
    const media: string[] = [];
    for (const k of MEDIA_KEYS) for (const x of arr(m[k])) { const uri = str(obj(x)?.uri); if (uri) media.push(baseName(uri)); }
    const sticker = str(obj(m.sticker)?.uri);
    if (sticker) media.push(baseName(sticker));
    const share = str(obj(m.share)?.link);
    if (!text && !media.length && !share) continue;
    messages.push({ at, author: author || null, text: share && !text.includes(share) ? `${text} ${share}`.trim() : text, media });
  }
  const title = str(o.title) ?? str(o.threadName) ?? (participants.join(", ") || key);
  return { key, title, participants, messages, instagram };
}

/** The account owner's name from profile_information.json (Facebook or Instagram). */
function profileName(json: unknown): string | null {
  const o = obj(json);
  const fb = str(obj(obj(obj(o?.profile_v2)?.name))?.full_name) ?? str(obj(obj(o?.profile)?.name)?.full_name);
  if (fb) return fb;
  // Instagram: profile_user[0].string_map_data.Name.value
  const ig = obj(arr(o?.profile_user)[0]);
  return str(obj(obj(ig?.string_map_data)?.Name)?.value) ?? null;
}

function safeJson(bytes: Uint8Array): unknown {
  try { return JSON.parse(decodeText(bytes)); } catch { return null; }
}

/** The person in (nearly) every conversation, when there are several. */
function ownerFromThreads(threads: RawThread[]): string | null {
  if (threads.length < 2) return null;
  const counts = new Map<string, { name: string; n: number }>();
  for (const t of threads) for (const p of new Set(t.participants.map(normName))) {
    const c = counts.get(p);
    if (c) c.n++; else counts.set(p, { name: t.participants.find((x) => normName(x) === p)!, n: 1 });
  }
  const top = [...counts.values()].sort((a, b) => b.n - a.n);
  if (!top[0] || top[0].n < Math.max(2, Math.ceil(threads.length * 0.8))) return null;
  if (top[1] && top[1].n === top[0].n) return null;
  return top[0].name;
}

function toThread(t: RawThread, owner: string | null): ChatThread {
  const others = t.participants.filter((p) => !owner || normName(p) !== normName(owner));
  // A single thread: in a two-person chat titled after one of them, the other one is the owner.
  let me = owner && t.participants.some((p) => normName(p) === normName(owner)) ? t.participants.find((p) => normName(p) === normName(owner))! : null;
  if (!me && t.participants.length === 2 && t.participants.some((p) => normName(p) === normName(t.title))) {
    me = t.participants.find((p) => normName(p) !== normName(t.title)) ?? null;
  }
  // Message authors are names; make the owner's key the exact spelling used in the messages.
  if (me) {
    const spelled = t.messages.find((m) => m.author && normName(m.author) === normName(me!))?.author;
    if (spelled) me = spelled;
  }
  return { title: t.title, messages: t.messages, me, group: (owner ? others.length : t.participants.length - 1) > 1 };
}

function readMessenger(input: ImportInput, ctx: ImportContext): ImportPlan {
  const raw: RawThread[] = [];
  let owner: string | null = null;
  const warnings: string[] = [];
  if (input.entries) {
    const byThread = new Map<string, RawThread>();
    for (const e of input.entries) {
      if (PROFILE_FILE.test(e.name)) { owner = owner ?? profileName(safeJson(e.bytes)); continue; }
      const m = THREAD_FILE.exec(e.name);
      if (!m) continue;
      const instagram = /(^|\/)your_instagram_activity\//.test(e.name) || /(^|\/)instagram/i.test(e.name);
      const key = e.name.slice(0, e.name.lastIndexOf("/"));
      const t = parseThreadJson(safeJson(e.bytes), m[1], instagram);
      if (!t) { warnings.push(`${e.name} couldn't be read.`); continue; }
      const prev = byThread.get(key);
      if (prev) prev.messages.push(...t.messages);
      else byThread.set(key, t);
    }
    raw.push(...byThread.values());
  } else {
    const t = parseThreadJson(safeJson(input.bytes), baseName(input.filename));
    if (t) raw.push(t);
  }
  if (!raw.length) return { segments: [], changes: [], counts: {}, warnings: ["No Messenger or Instagram conversations were found in this file."] };
  owner = owner ?? ownerFromThreads(raw);
  const threads = raw.filter((t) => t.messages.length).map((t) => toThread(t, owner));
  const app = raw.every((t) => t.instagram) ? "Instagram" : raw.some((t) => t.instagram) ? "Messenger and Instagram" : "Messenger";
  const n = threads.reduce((s, t) => s + t.messages.length, 0);
  const title = threads.length === 1
    ? (ctx.locale === "da" ? `${app}-chat med ${threads[0].title} (${n} beskeder)` : `${app} chat with ${threads[0].title} (${n} messages)`)
    : (ctx.locale === "da" ? `${app}: ${threads.length} samtaler (${n} beskeder)` : `${app}: ${threads.length} conversations (${n} messages)`);
  return chatPlan({ app: app === "Instagram" ? "Instagram" : "Messenger", threads, title, warnings }, ctx);
}

export const messengerImporter: Importer = {
  id: "messenger",
  label: "Messenger or Instagram chats",
  mime: "application/json",
  sensitive: true,
  detect({ filename, head }) {
    if (!/^message_\d+\.json$/i.test(baseName(filename))) return false;
    const s = new TextDecoder("utf-8").decode(head).trimStart();
    return s.startsWith("{") && /"participants"\s*:/.test(s) && /"(?:sender_name|senderName)"\s*:/.test(s);
  },
  detectArchive({ names }) {
    // Meta's own folder layout (messages/inbox/<thread>/message_1.json); the HTML version of the export isn't read.
    return names.some((n) => THREAD_FILE.test(n));
  },
  acceptEntry: (name) => THREAD_FILE.test(name) || PROFILE_FILE.test(name),
  read: readMessenger,
};
