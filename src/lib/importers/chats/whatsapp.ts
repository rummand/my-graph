/**
 * Importer `whatsapp`: a chat from WhatsApp's "Export chat", as the .txt (Android, or iOS's _chat.txt) or the .zip
 * it shares (with or without media). English and Danish phones, 12/24-hour clocks, day-first or month-first dates.
 * Pure.
 *
 *   iOS      [12.03.24, 14.05.33] Mor: Hej skat          (_chat.txt inside "WhatsApp Chat - Mor.zip")
 *   iOS (en) [3/12/24, 2:05:33 PM] Mum: Hi love
 *   Android  12/03/2024, 14:05 - Mor: Hej skat          ("WhatsApp Chat with Mor.txt", "WhatsApp-chat med Mor.txt")
 *
 * Photos and files in the zip are kept only as mentions in the text ("[attached: IMG-…jpg]"); they are not saved as
 * their own library items in this round.
 */
import type { Importer, ImportInput, ImportContext, ImportPlan } from "../types";
import { baseName, chatPlan, decodeText, fromLocal, stripMarks, type ChatMessage, type ChatThread } from "./common";

const SP = "[ \\u00A0\\u202F]";
const MARKS = "[\\u200E\\u200F\\u202A-\\u202E\\uFEFF]*";
const DATE = "(\\d{1,4})[./-](\\d{1,2})[./-](\\d{1,4})";
const TIME = `(\\d{1,2})[:.](\\d{2})(?:[:.](\\d{2}))?(?:${SP}*([AaPp])\\.?${SP}?[Mm]\\.?)?`;
/** iOS: "[date, time] rest". */
const BRACKET = new RegExp(`^${MARKS}\\[${DATE},?${SP}+${TIME}\\]${SP}+([\\s\\S]*)$`);
/** Android: "date, time - rest". */
const DASH = new RegExp(`^${MARKS}${DATE},?${SP}+${TIME}${SP}+[-–]${SP}+([\\s\\S]*)$`);

type Style = "bracket" | "dash";
type RawLine = { a: number; b: number; c: number; aLen: number; cLen: number; h: number; mi: number; s: number; ampm: string | null; rest: string };

function parseLine(line: string, style: Style): RawLine | null {
  const m = (style === "bracket" ? BRACKET : DASH).exec(line);
  if (!m) return null;
  return {
    a: Number(m[1]), b: Number(m[2]), c: Number(m[3]), aLen: m[1].length, cLen: m[3].length,
    h: Number(m[4]), mi: Number(m[5]), s: m[6] ? Number(m[6]) : 0, ampm: m[7] ? m[7].toLowerCase() : null, rest: m[8],
  };
}

function styleOf(line: string): Style | null {
  if (BRACKET.test(line)) return "bracket";
  if (DASH.test(line)) return "dash";
  return null;
}

/** Name patterns of the export: "WhatsApp Chat with Mor", "WhatsApp-chat med Mor", "WhatsApp Chat - Mor". */
const EXPORT_NAME = /^WhatsApp[ -]?(?:Chat|chat|Chatt?)(?: with | med | - | – |-)(.+?)(?:\.(?:txt|zip))?$/;

export function chatNameFromFile(filename: string): string | null {
  const m = EXPORT_NAME.exec(baseName(filename).trim());
  return m ? m[1].trim() : null;
}

const isChatTxt = (name: string) => /^_chat\.txt$/i.test(name) || (EXPORT_NAME.test(name) && /\.txt$/i.test(name));

/** First lines of a text look like a WhatsApp export (the first non-empty line and most of the next ones). */
export function looksLikeWhatsApp(text: string): boolean {
  const lines = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 12);
  if (!lines.length) return false;
  const style = styleOf(lines[0]);
  if (!style) return false;
  const hits = lines.filter((l) => parseLine(l, style)).length;
  return hits >= Math.min(2, lines.length) && hits >= lines.length / 3;
}

/* ── Message bodies ───────────────────────────────────────────────────────────────────────────────────────── */

const ATTACHED_IOS = /<(?:attached|vedhæftet|vedhæftede|vedhæftning)\s*:\s*([^>]+)>/i;
const ATTACHED_ANDROID = /^(.+?\.[A-Za-z0-9]{2,5})\s+\((?:file attached|fil vedhæftet|vedhæftet fil)\)\s*([\s\S]*)$/i;
const OMITTED = /^(?:<\s*(?:Media omitted|Medie udeladt|Medier udeladt|Mediefil udeladt)\s*>|(?:image|video|audio|sticker|GIF|document|Contact card|photo) omitted|(?:billede|video|lyd|lydfil|sticker|GIF|dokument|kontaktkort|foto) (?:udeladt|udelades))$/i;
const YOU_DELETED = /^(?:You deleted this message\.?|Du slettede denne besked\.?|Du har slettet denne besked\.?)$/i;
/** Android system lines put the actor in the text with no colon; these words never belong in a person's name. */
const SYSTEM_WORDS = /\b(?:created|changed|added|removed|left|joined|deleted|tilføjede|fjernede|forlod|oprettede|ændrede|skiftede|sluttede sig|blev tilføjet|end-to-end|krypteret|encrypted)\b|["“”]/i;
const GROUP_HINT = /\b(?:created group|created this group|oprettede gruppen|oprettede denne gruppe|added|tilføjede|changed the subject|changed the group|ændrede emnet|ændrede gruppens|left|forlod)\b/i;

type Parsed = { at: RawLine; author: string | null; text: string; media: string[]; deletedByMe: boolean; system: boolean; iosSystemAuthor: string | null };

function readBody(rest: string): Omit<Parsed, "at"> {
  const m = /^([^:\n]{1,80}?): ([\s\S]*)$/.exec(rest) ?? /^([^:\n]{1,80}?):$/.exec(rest);
  if (!m || SYSTEM_WORDS.test(m[1])) {
    return { author: null, text: stripMarks(rest).trim(), media: [], deletedByMe: false, system: true, iosSystemAuthor: null };
  }
  const author = stripMarks(m[1]).trim();
  const raw = m[2] ?? "";
  const body = stripMarks(raw).trim();
  const media: string[] = [];
  let text = body;
  const ios = ATTACHED_IOS.exec(body);
  if (ios) { media.push(ios[1].trim()); text = body.replace(ATTACHED_IOS, "").trim(); }
  const android = !ios ? ATTACHED_ANDROID.exec(body) : null;
  if (android) { media.push(android[1].trim()); text = android[2].trim(); }
  if (!media.length && OMITTED.test(body)) { media.push(""); text = ""; }
  // iOS marks its own lines (encryption notice, "X added Y") with a direction mark right after "Name: ".
  if (!media.length && /^[‎‏]/.test(raw)) {
    return { author: null, text: body, media: [], deletedByMe: false, system: true, iosSystemAuthor: author };
  }
  return { author, text, media, deletedByMe: YOU_DELETED.test(body), system: false, iosSystemAuthor: null };
}

/** Day-first or month-first, from the dates themselves (a day above 12 settles it), then the clock (AM/PM: US). */
function dateOrder(lines: RawLine[]): "dmy" | "mdy" | "ymd" {
  if (lines.some((l) => l.aLen === 4)) return "ymd";
  if (lines.some((l) => l.a > 12)) return "dmy";
  if (lines.some((l) => l.b > 12)) return "mdy";
  return lines.some((l) => l.ampm) ? "mdy" : "dmy";
}

function toDate(l: RawLine, order: "dmy" | "mdy" | "ymd"): Date | null {
  let y: number, mo: number, d: number;
  if (order === "ymd") { y = l.a; mo = l.b; d = l.c; } else if (order === "dmy") { d = l.a; mo = l.b; y = l.c; } else { mo = l.a; d = l.b; y = l.c; }
  if (y < 100) y += 2000;
  let h = l.h;
  if (l.ampm === "p" && h < 12) h += 12;
  if (l.ampm === "a" && h === 12) h = 0;
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || l.mi > 59 || l.s > 59 || y < 2009 || y > 2100) return null;
  return fromLocal({ y, mo, d, h, mi: l.mi, s: l.s });
}

export type WhatsAppChat = { thread: ChatThread; skipped: number };

/** Parse an exported chat. `fileName` (the upload or the zip) names the chat when the text doesn't. */
export function parseWhatsApp(text: string, fileName: string): WhatsAppChat {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const first = lines.find((l) => l.trim());
  const style = first ? styleOf(first) : null;
  const parsed: Parsed[] = [];
  if (style) {
    for (const line of lines) {
      const l = parseLine(line, style);
      if (l) parsed.push({ at: l, ...readBody(l.rest) });
      else if (parsed.length) {
        const prev = parsed[parsed.length - 1];
        prev.text = prev.text ? `${prev.text}\n${stripMarks(line)}` : stripMarks(line);
      }
    }
  }
  const order = dateOrder(parsed.map((p) => p.at));
  const messages: ChatMessage[] = [];
  let skipped = 0;
  for (const p of parsed) {
    const at = toDate(p.at, order);
    if (!at) { skipped++; continue; }
    messages.push({ at, author: p.author, text: p.text.trim(), media: p.media });
  }

  const authors = new Map<string, number>();
  for (const m of messages) if (m.author) authors.set(m.author, (authors.get(m.author) ?? 0) + 1);
  const iosChatName = parsed.find((p) => p.iosSystemAuthor)?.iosSystemAuthor ?? null;
  const chatName = chatNameFromFile(fileName) ?? iosChatName;
  const group = authors.size > 2 || parsed.some((p) => p.system && GROUP_HINT.test(p.text)) || (!!iosChatName && !authors.has(iosChatName) && authors.size > 1);

  // Who exported it: whoever "deleted this message" themselves, else in a two-person chat the one who isn't the chat.
  let me = parsed.find((p) => p.deletedByMe && p.author)?.author ?? null;
  if (!me && !group && chatName && authors.has(chatName) && authors.size === 2) me = [...authors.keys()].find((a) => a !== chatName) ?? null;

  const title = chatName ?? (group ? "WhatsApp group" : [...authors.keys()].filter((a) => a !== me).join(", ") || "WhatsApp chat");
  return { thread: { title, messages, me, group }, skipped };
}

function readWhatsApp(input: ImportInput, ctx: ImportContext): ImportPlan {
  let text: string | null = null;
  let name = input.filename;
  if (input.entries) {
    const entry = input.entries.find((e) => isChatTxt(baseName(e.name)) && !e.name.includes("/")) ?? input.entries.find((e) => isChatTxt(baseName(e.name)));
    if (entry) {
      text = decodeText(entry.bytes);
      // iOS names the zip after the chat and the text "_chat.txt"; Android names both.
      if (!chatNameFromFile(input.filename)) name = entry.name;
    }
  } else {
    text = decodeText(input.bytes);
  }
  if (!text || !looksLikeWhatsApp(text)) {
    return { segments: [], changes: [], counts: {}, warnings: ["This doesn't look like a WhatsApp chat export, so nothing was read from it."] };
  }
  const { thread, skipped } = parseWhatsApp(text, name);
  const warnings: string[] = [];
  if (skipped) warnings.push(`${skipped} line${skipped === 1 ? "" : "s"} had a date that couldn't be read and ${skipped === 1 ? "was" : "were"} left out.`);
  if (input.entries) warnings.push("Photos and files in the zip are named in the text but not saved as their own items.");
  const n = thread.messages.length;
  const title = ctx.locale === "da"
    ? `WhatsApp-chat${thread.group ? "" : " med"} ${thread.title} (${n} beskeder)`
    : `WhatsApp chat${thread.group ? "" : " with"} ${thread.title} (${n} messages)`;
  return chatPlan({ app: "WhatsApp", threads: [thread], title, warnings }, ctx);
}

export const whatsappImporter: Importer = {
  id: "whatsapp",
  label: "WhatsApp chat",
  mime: "text/plain",
  sensitive: true,
  detect({ filename, head }) {
    const base = baseName(filename);
    if (!/\.txt$/i.test(base) || !isChatTxt(base)) return false;
    return looksLikeWhatsApp(new TextDecoder("utf-8").decode(head));
  },
  detectArchive({ names }) {
    const files = names.filter((n) => !n.endsWith("/") && !/(^|\/)(__MACOSX\/|\._)/.test(n));
    const chats = files.filter((n) => isChatTxt(baseName(n)));
    // One chat text, everything at the top level (WhatsApp's zip has no folders; a re-zipped one may have one).
    const folders = new Set(files.map((n) => n.split("/").slice(0, -1).join("/")));
    // The rest is media (photos, voice notes, shared files), never other text, notes or emails.
    const others = files.filter((n) => !isChatTxt(baseName(n)));
    return chats.length === 1 && folders.size === 1 && files.every((n) => n.split("/").length <= 2)
      && !others.some((n) => /\.(txt|md|eml|json|csv)$/i.test(n));
  },
  acceptEntry: (name) => isChatTxt(baseName(name)),
  read: readWhatsApp,
};
