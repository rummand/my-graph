/**
 * Shared by the chat importers (WhatsApp, Messenger/Instagram, iMessage). Pure.
 *
 * A chat becomes searchable text, one segment per conversation per day (split after `perSegment` messages), each
 * with a locator naming the conversation and the day. The people who wrote in it are matched against the graph
 * (phone, email, then a unique name); the ones the graph doesn't know are proposed, never the person who exported
 * the chat ("me"). The model also reads the text (`extract: true`) for plans, dates and people mentioned.
 */
import type { ChangeInput } from "@/lib/changes";
import type { TextSegment } from "@/lib/ingest/chunk";
import { contactsOf, matchPerson, normEmail, normName, normPhone } from "../match";
import type { ImportContext, ImportKnown, ImportPlan } from "../types";

/* ── Time: chat exports carry wall-clock times; My Graph is Danish, so they are read as Copenhagen time ─────── */

export const CHAT_TZ = "Europe/Copenhagen";
const partsFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: CHAT_TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});

export type WallClock = { y: number; mo: number; d: number; h: number; mi: number; s: number };

/** The wall-clock time in Copenhagen of an instant. */
export function localParts(at: Date): WallClock {
  const p: Record<string, number> = {};
  for (const x of partsFmt.formatToParts(at)) if (x.type !== "literal") p[x.type] = Number(x.value);
  return { y: p.year, mo: p.month, d: p.day, h: p.hour === 24 ? 0 : p.hour, mi: p.minute, s: p.second };
}

/** The instant a Copenhagen wall-clock time names (DST-aware). */
export function fromLocal(w: WallClock): Date {
  const guess = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
  const offsetAt = (t: number) => { const p = localParts(new Date(t)); return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - t; };
  let t = guess - offsetAt(guess);
  const second = offsetAt(t);
  if (guess - second !== t) t = guess - second;
  return new Date(t);
}

const pad = (n: number) => String(n).padStart(2, "0");
export const dayKey = (at: Date) => { const p = localParts(at); return `${p.y}-${pad(p.mo)}-${pad(p.d)}`; };
export const clock = (at: Date) => { const p = localParts(at); return `${pad(p.h)}:${pad(p.mi)}`; };

/* ── Text helpers ─────────────────────────────────────────────────────────────────────────────────────────── */

/** UTF-8 text of a file, without a byte-order mark. */
export function decodeText(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes).replace(/^﻿/, "");
}

/** Direction marks and zero-width characters WhatsApp and others sprinkle in. */
export const stripMarks = (s: string) => s.replace(/[​-‏‪-‮⁦-⁩﻿]/g, "");

export const looksLikePhone = (s: string) => /^\+?[\d\s().-]{6,20}$/.test(s.trim()) && s.replace(/\D/g, "").length >= 6;
export const looksLikeEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());

export const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;

/* ── Chats ────────────────────────────────────────────────────────────────────────────────────────────────── */

export type ChatMessage = {
  at: Date;
  /** The author's key in `ChatThread.people` (a name, a handle, or "me"); null for a system line. */
  author: string | null;
  text: string;
  /** Photos, videos, voice notes and files: their file names, or "" when the export left them out. */
  media: string[];
};

export type ChatPerson = { name: string | null; phones?: string[]; emails?: string[] };

export type ChatThread = {
  title: string;
  messages: ChatMessage[];
  /** The author key of the person who exported the chat, when it can be told. Never proposed. */
  me: string | null;
  group: boolean;
  /** What is known about each author key (name, phone, email). Keys without an entry are names. */
  people?: Record<string, ChatPerson>;
};

export const CHAT_RULES = {
  /** Messages per searchable segment (a busy day is split). */
  perSegment: 150,
  /** New people proposed from one import at most. */
  maxPeople: 300,
  /** Messages read from one import at most. */
  maxMessages: 250_000,
};

function personOf(t: ChatThread, key: string): ChatPerson {
  return t.people?.[key] ?? { name: key };
}

function displayName(t: ChatThread, key: string | null, locale: "en" | "da"): string {
  if (key === null) return "";
  if (key === t.me) return personOf(t, key).name ?? (locale === "da" ? "Mig" : "Me");
  const p = personOf(t, key);
  return p.name ?? key;
}

function messageLine(t: ChatThread, m: ChatMessage, locale: "en" | "da"): string {
  const media = m.media.map((f) => (f ? `[${locale === "da" ? "vedhæftet" : "attached"}: ${f}]` : `[${locale === "da" ? "medie udeladt" : "media omitted"}]`));
  const body = [m.text.trim(), ...media].filter(Boolean).join(" ");
  if (m.author === null) return `${clock(m.at)} — ${body}`;
  return `${clock(m.at)} ${displayName(t, m.author, locale)}: ${body}`;
}

/** Where a thread's day lives in the text: "Mor · 2024-03-12" (and " (2)" for the second part of a busy day). */
const regionOf = (title: string, day: string, part: number) => `${title} · ${day}${part > 1 ? ` (${part})` : ""}`;

export type ChatPlanInput = {
  /** "WhatsApp", "Messenger", "Instagram", "iMessage". */
  app: string;
  threads: ChatThread[];
  title?: string;
  warnings?: string[];
};

/** Searchable segments, people proposals, counts and dates for one or more chat threads. */
export function chatPlan(input: ChatPlanInput, ctx: ImportContext): ImportPlan {
  const warnings = [...(input.warnings ?? [])];
  const segments: TextSegment[] = [];
  let messages = 0;
  let media = 0;
  let last: Date | null = null;
  let truncated = false;
  /** First line written by each author (person key → quote + region), for the receipts. */
  type Seen = { thread: ChatThread; key: string; quote: string; region: string; count: number };
  const seen = new Map<string, Seen>();
  const meNames = new Set<string>();

  for (const t of input.threads) {
    if (t.me) {
      const n = personOf(t, t.me).name;
      if (n) meNames.add(normName(n));
    }
    const msgs = [...t.messages].sort((a, b) => a.at.getTime() - b.at.getTime());
    let day = "";
    let part = 0;
    let inPart = 0;
    let lines: string[] = [];
    let region = "";
    const flush = () => {
      if (!lines.length) return;
      const head = `${input.app} · ${t.title} · ${day}${part > 1 ? ` (${part})` : ""}`;
      segments.push({ text: `${head}\n${lines.join("\n")}`, at: { region } });
      lines = [];
    };
    for (const m of msgs) {
      if (messages >= CHAT_RULES.maxMessages) { truncated = true; break; }
      const d = dayKey(m.at);
      if (d !== day || inPart >= CHAT_RULES.perSegment) {
        flush();
        part = d !== day ? 1 : part + 1;
        day = d;
        inPart = 0;
        region = regionOf(t.title, day, part);
      }
      const line = messageLine(t, m, ctx.locale);
      lines.push(line);
      inPart++;
      messages++;
      media += m.media.length;
      if (!last || m.at > last) last = m.at;
      if (m.author !== null && m.author !== t.me) {
        const id = personKey(personOf(t, m.author), m.author);
        const s = seen.get(id);
        if (s) s.count++;
        else seen.set(id, { thread: t, key: m.author, quote: line.slice(0, 240), region, count: 1 });
      }
    }
    flush();
  }
  if (truncated) warnings.push(`Only the first ${CHAT_RULES.maxMessages.toLocaleString("en")} messages were read.`);

  const people = proposePeople([...seen.values()].filter((s) => !meNames.has(normName(personOf(s.thread, s.key).name ?? ""))), input.app, ctx);
  warnings.push(...people.warnings);
  if (input.threads.some((t) => !t.me && t.group) && people.proposed > 0) {
    warnings.push("Couldn't tell which name in a group chat is yours. If you are among the people proposed, drop that one.");
  }

  return {
    segments,
    changes: people.changes,
    counts: {
      chats: input.threads.length, messages, "photos and files mentioned": media,
      "new people": people.proposed, "people already known": people.matched, "contact details": people.updates,
    },
    warnings,
    title: input.title,
    occurredAt: last,
    extract: true,
  };
}

/** One key per real person: their phone, else email, else name. */
function personKey(p: ChatPerson, key: string): string {
  const phone = (p.phones ?? []).map(normPhone).find((x) => x.length >= 8);
  if (phone) return `tel:${phone}`;
  const email = (p.emails ?? []).map(normEmail).find(Boolean);
  if (email) return `mailto:${email}`;
  return `name:${normName(p.name ?? key)}`;
}

/** Match each author against the graph; propose the unknown ones and contact details the known ones lack. */
function proposePeople(
  list: { thread: ChatThread; key: string; quote: string; region: string; count: number }[], app: string, ctx: ImportContext,
): { changes: ChangeInput[]; proposed: number; matched: number; updates: number; warnings: string[] } {
  const changes: ChangeInput[] = [];
  const warnings: string[] = [];
  let proposed = 0;
  let matched = 0;
  let updates = 0;
  let unnamed = 0;
  const done = new Set<string>();
  // Most active first, so a cap keeps the people who matter.
  for (const s of [...list].sort((a, b) => b.count - a.count)) {
    const p = personOf(s.thread, s.key);
    const name = p.name?.trim() || null;
    const phones = [...(p.phones ?? []), ...(name && looksLikePhone(name) ? [name] : [])];
    const emails = [...(p.emails ?? []), ...(name && looksLikeEmail(name) ? [name] : [])];
    const realName = name && !looksLikePhone(name) && !looksLikeEmail(name) ? name : null;
    const receipt = { sourceId: ctx.sourceId, quote: s.quote, locator: { region: s.region } };
    const hit = matchPerson(ctx.known, { name: realName, phones, emails });
    if (hit) {
      if (done.has(hit.id)) continue;
      done.add(hit.id);
      matched++;
      const add = missingContacts(hit, phones, emails);
      if (add) {
        changes.push({ op: "updateNode", nodeId: hit.id, set: { props: add }, note: `Wrote in the ${app} chat “${s.thread.title}” from this number or address.`, receipt });
        updates++;
      }
      continue;
    }
    if (!realName) { unnamed++; continue; }
    if (proposed >= CHAT_RULES.maxPeople) continue;
    const props: Record<string, unknown> = {};
    if (phones[0]) props.phone = phones[0].trim();
    if (emails[0]) props.email = normEmail(emails[0]);
    changes.push({
      op: "addNode", nodeId: ctx.mint(), type: "person", label: realName, props, visibility: ctx.visibility,
      note: `Wrote ${s.count} message${s.count === 1 ? "" : "s"} in the ${app} chat “${s.thread.title}”.`, receipt,
    });
    proposed++;
  }
  if (unnamed) warnings.push(`${unnamed} ${unnamed === 1 ? "number or address" : "numbers or addresses"} in the chat had no name and matched nobody in the graph, so nobody was proposed for ${unnamed === 1 ? "it" : "them"}.`);
  if (list.length - matched - unnamed > CHAT_RULES.maxPeople) warnings.push(`Only the ${CHAT_RULES.maxPeople} most active people were proposed.`);
  return { changes, proposed, matched, updates, warnings };
}

/** A phone or email the known person doesn't carry yet, only into an empty field (never overwrites). */
function missingContacts(k: ImportKnown, phones: string[], emails: string[]): Record<string, string> | null {
  const c = contactsOf(k);
  const out: Record<string, string> = {};
  const phone = phones.find((p) => normPhone(p).length >= 8);
  if (phone && !c.phones.includes(normPhone(phone)) && k.props.phone == null) out.phone = phone.trim();
  const email = emails.find(Boolean);
  if (email && !c.emails.includes(normEmail(email)) && k.props.email == null) out.email = normEmail(email);
  return Object.keys(out).length ? out : null;
}
