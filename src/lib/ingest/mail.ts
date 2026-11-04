/**
 * Mail helpers. Pure: splitting a mailbox (.mbox) into messages, reading address lists, and the thread key that
 * groups a correspondence (the root of References, else In-Reply-To, else the message's own id, else the subject).
 */
import type { ParsedEmail } from "./email";

/* ── mbox ─────────────────────────────────────────────────────────────────────────────────────────────── */

/** The mboxrd/mboxo separator: a line starting "From " followed by an address or "-" and a date-ish rest. */
const FROM_LINE = /^From [^\s]+ .*$/;

/**
 * Split an mbox file into raw RFC 822 messages. Messages start at a "From " line that follows a blank line (or the
 * start of the file); ">From " escaping inside bodies is undone. Empty messages are dropped.
 */
export function splitMbox(text: string): string[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let cur: string[] | null = null;
  let prevBlank = true;
  for (const line of lines) {
    if (prevBlank && FROM_LINE.test(line)) {
      if (cur) out.push(cur.join("\n"));
      cur = [];
      prevBlank = false;
      continue;
    }
    if (cur) cur.push(/^>+From /.test(line) ? line.slice(1) : line);
    prevBlank = line.trim() === "";
  }
  if (cur) out.push(cur.join("\n"));
  return out.map((m) => m.replace(/\n+$/, "\n")).filter((m) => /^[!-9;-~]+:/m.test(m.slice(0, 2000)) && m.trim().length > 0);
}

/** True when the start of a text file looks like an mbox (first non-empty line is a "From " separator). */
export function looksLikeMbox(head: string): boolean {
  const first = head.replace(/^﻿/, "").split(/\r?\n/).find((l) => l.trim() !== "");
  return !!first && FROM_LINE.test(first);
}

/* ── Addresses ───────────────────────────────────────────────────────────────────────────────────────── */

export type Address = { name: string | null; email: string };

/** "Anna Hansen <anna@x.dk>, \"Lærer, Bo\" <bo@skole.dk>, c@y.dk" → addresses (emails lower-cased). */
export function parseAddresses(v: string | undefined | null): Address[] {
  if (!v) return [];
  const out: Address[] = [];
  // Split on commas outside quotes and angle brackets.
  const parts: string[] = [];
  let buf = "", quoted = false, angle = 0;
  for (const ch of v) {
    if (ch === '"') quoted = !quoted;
    else if (ch === "<" && !quoted) angle++;
    else if (ch === ">" && !quoted) angle = Math.max(0, angle - 1);
    if ((ch === "," || ch === ";") && !quoted && angle === 0) { parts.push(buf); buf = ""; continue; }
    buf += ch;
  }
  parts.push(buf);
  for (const raw of parts) {
    const p = raw.trim();
    if (!p) continue;
    const m = p.match(/^(.*?)<\s*([^<>\s]+@[^<>\s]+)\s*>\s*$/);
    if (m) {
      const name = m[1].trim().replace(/^"|"$/g, "").replace(/\\"/g, '"').trim();
      out.push({ name: name && name.toLowerCase() !== m[2].toLowerCase() ? name : null, email: m[2].toLowerCase() });
      continue;
    }
    const bare = p.match(/([^\s<>"]+@[^\s<>"]+)/);
    if (bare) {
      const rest = p.replace(bare[1], "").replace(/[()"]/g, "").trim();
      out.push({ name: rest || null, email: bare[1].toLowerCase() });
    }
  }
  const seen = new Set<string>();
  return out.filter((a) => (seen.has(a.email) ? false : (seen.add(a.email), true)));
}

export type Participant = Address & { role: "from" | "to" | "cc" };

/** Everyone on a message, sender first, each address once. */
export function participantsOf(e: Pick<ParsedEmail, "from" | "to" | "cc">): Participant[] {
  const out: Participant[] = [];
  const seen = new Set<string>();
  const add = (list: Address[], role: Participant["role"]) => {
    for (const a of list) if (!seen.has(a.email)) { seen.add(a.email); out.push({ ...a, role }); }
  };
  add(parseAddresses(e.from), "from");
  add(parseAddresses(e.to), "to");
  add(parseAddresses(e.cc), "cc");
  return out;
}

/** A display name for an address: the name when there is one, else the part before @ ("bo.hansen" → "Bo Hansen"). */
export function displayName(a: Address): string {
  if (a.name) return a.name;
  const local = a.email.split("@")[0].replace(/[._-]+/g, " ").trim();
  return local ? local.replace(/\b\p{L}/gu, (c) => c.toUpperCase()) : a.email;
}

/* ── Threads ─────────────────────────────────────────────────────────────────────────────────────────── */

/** "Re: SV: Fwd: VS: Forældremøde" → "forældremøde". Danish (Sv, Vs, Vedr) and English prefixes. */
export function normalizeSubject(s: string | undefined | null): string {
  let t = (s ?? "").normalize("NFKC").trim();
  for (;;) {
    const next = t.replace(/^\s*(re|sv|aw|fw|fwd|vs|vedr|wg|tr)\s*(\[\d+\])?\s*:\s*/i, "").replace(/^\[[^\]]{1,40}\]\s*/, "");
    if (next === t) break;
    t = next;
  }
  return t.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * The key that groups a message with the rest of its conversation. Prefer the first id in References (the thread's
 * root), then In-Reply-To, then the message's own id; messages without any ids group by their cleaned subject.
 */
export function threadKeyFor(e: Pick<ParsedEmail, "messageId" | "inReplyTo" | "references" | "subject">): string | null {
  const root = e.references[0] ?? e.inReplyTo ?? e.messageId;
  if (root) return `mid:${root.toLowerCase()}`;
  const subj = normalizeSubject(e.subject);
  return subj ? `subj:${subj}` : null;
}

/**
 * Merge thread keys across a set of messages: a reply that only names its parent (In-Reply-To) joins the thread
 * that parent belongs to, however deep the chain. Returns lower-cased messageId → key. The key of a group is the
 * root declared in References when any member names one, else the id of the message that replies to nothing, so a
 * message read on its own (threadKeyFor) and the same message read in a batch land in the same thread.
 */
export function resolveThreads(msgs: { messageId?: string; inReplyTo?: string; references: string[]; subject?: string }[]): Map<string, string> {
  const parent = new Map<string, string>();
  const find = (k: string): string => {
    let r = k;
    while (parent.get(r) !== r) r = parent.get(r)!;
    return r;
  };
  const touch = (k: string) => { if (!parent.has(k)) parent.set(k, k); };
  const union = (a: string, b: string) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(rb, ra); };
  const withId = msgs.filter((m) => m.messageId);
  for (const m of withId) {
    const id = m.messageId!.toLowerCase();
    touch(id);
    for (const r of [...m.references, ...(m.inReplyTo ? [m.inReplyTo] : [])]) {
      const rid = r.toLowerCase();
      touch(rid);
      union(rid, id);
    }
  }
  const declared = new Map<string, string>(); // group root → key
  for (const m of withId) {
    if (!m.references.length) continue;
    const g = find(m.messageId!.toLowerCase());
    const k = `mid:${m.references[0].toLowerCase()}`;
    if (!declared.has(g) || k < declared.get(g)!) declared.set(g, k);
  }
  for (const m of withId) {
    if (m.references.length || m.inReplyTo) continue;
    const id = m.messageId!.toLowerCase();
    const g = find(id);
    if (!declared.has(g)) declared.set(g, `mid:${id}`);
  }
  // Neither: the group hangs off a message that isn't here. Its id (the missing ancestor) is the key.
  const present = new Set(withId.map((m) => m.messageId!.toLowerCase()));
  const missing = new Map<string, string>();
  for (const k of parent.keys()) {
    if (present.has(k)) continue;
    const g = find(k);
    const key = `mid:${k}`;
    if (!missing.has(g) || key < missing.get(g)!) missing.set(g, key);
  }
  for (const [g, key] of missing) if (!declared.has(g)) declared.set(g, key);
  const out = new Map<string, string>();
  for (const m of withId) {
    const id = m.messageId!.toLowerCase();
    const g = find(id);
    out.set(id, declared.get(g) ?? threadKeyFor(m) ?? `mid:${id}`);
  }
  return out;
}
