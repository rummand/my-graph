/**
 * A vCard reader (pure): vCard 2.1, 3.0 and 4.0, many cards per file, folded lines, quoted-printable with its
 * CHARSET, escaped values, Apple's item groups (X-ABRELATEDNAMES + X-ABLabel, X-ABShowAs:COMPANY, BDAY with
 * X-APPLE-OMIT-YEAR), RELATED (text, or a urn:uuid pointing at another card in the file), Android's relation rows,
 * and company cards (KIND:org). PHOTO, LOGO, SOUND and KEY are skipped. Each card becomes a `Contact`.
 */
import { clampContact, normBirthday, type Contact, type RawContact } from "./shape";

type Prop = { group: string | null; name: string; params: Record<string, string[]>; value: string };

/** Decode a file's bytes: UTF-8 (with or without BOM), UTF-16 with a BOM, else Windows-1252 (old Outlook exports). */
export function decodeVcfBytes(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  const body = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return new TextDecoder("windows-1252").decode(body);
  }
}

/** Is this the start of a vCard file? Only "BEGIN:VCARD" as the first thing in it counts (no false positives). */
export function looksLikeVCard(head: Uint8Array): boolean {
  let s: string;
  if ((head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff)) s = decodeVcfBytes(head);
  else s = new TextDecoder("utf-8").decode(head.subarray(0, 512));
  s = s.replace(/^﻿/, "").replace(/^\s+/, "");
  if (!/^BEGIN:VCARD\s*(\r?\n|$)/i.test(s)) return false;
  // A real card names its version or its name right after; a text file that merely starts with those words doesn't.
  return /^(VERSION|FN|N|UID|PRODID)[;:]/im.test(s.split(/\r?\n/).slice(1, 8).join("\n"));
}

const isQp = (head: string) => /QUOTED-PRINTABLE/i.test(head);

/** Logical lines: folded lines joined (a leading space or tab), quoted-printable soft breaks ("=" at the end) joined. */
export function unfold(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const last = out.length - 1;
    if (last >= 0 && (raw.startsWith(" ") || raw.startsWith("\t"))) { out[last] += raw.slice(1); continue; }
    if (last >= 0 && out[last].endsWith("=") && isQp(out[last].slice(0, Math.max(0, colonAt(out[last]))))) {
      out[last] = out[last].slice(0, -1) + raw;
      continue;
    }
    out.push(raw);
  }
  return out;
}

/** The first ':' outside double quotes (where the value starts), or -1. */
function colonAt(line: string): number {
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "\"") q = !q;
    else if (ch === ":" && !q) return i;
  }
  return -1;
}

function splitOutsideQuotes(s: string, sep: string): string[] {
  const out: string[] = [];
  let cur = "", q = false;
  for (const ch of s) {
    if (ch === "\"") { q = !q; cur += ch; continue; }
    if (ch === sep && !q) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

const BARE_ENCODINGS = new Set(["QUOTED-PRINTABLE", "BASE64", "B", "8BIT", "7BIT"]);

export function parseLine(line: string): Prop | null {
  const c = colonAt(line);
  if (c <= 0) return null;
  const [nameRaw, ...paramParts] = splitOutsideQuotes(line.slice(0, c), ";");
  const dot = nameRaw.lastIndexOf(".");
  const group = dot > 0 ? nameRaw.slice(0, dot) : null;
  const name = (dot > 0 ? nameRaw.slice(dot + 1) : nameRaw).trim().toUpperCase();
  if (!name) return null;
  const params: Record<string, string[]> = {};
  const add = (k: string, v: string) => { (params[k] ??= []).push(v); };
  for (const p of paramParts) {
    const eq = p.indexOf("=");
    if (eq < 0) {
      const bare = p.trim().toUpperCase();
      if (!bare) continue;
      add(BARE_ENCODINGS.has(bare) ? "ENCODING" : "TYPE", bare.toLowerCase());
      continue;
    }
    const k = p.slice(0, eq).trim().toUpperCase();
    for (const v of splitOutsideQuotes(p.slice(eq + 1), ",")) {
      const val = v.trim().replace(/^"(.*)"$/, "$1");
      if (val) add(k, k === "X-APPLE-OMIT-YEAR" || k === "CHARSET" ? val : val.toLowerCase());
    }
  }
  return { group, name, params, value: line.slice(c + 1) };
}

/** Quoted-printable text to a string in the given charset (UTF-8 when none or unknown). */
export function decodeQp(s: string, charset?: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "=" && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) { bytes.push(parseInt(s.slice(i + 1, i + 3), 16)); i += 2; continue; }
    if (ch === "=" && i === s.length - 1) continue;
    for (const b of new TextEncoder().encode(ch)) bytes.push(b);
  }
  const buf = new Uint8Array(bytes);
  try {
    return new TextDecoder((charset || "utf-8").toLowerCase(), { fatal: false }).decode(buf);
  } catch {
    return new TextDecoder("utf-8").decode(buf);
  }
}

/** Split a structured value on unescaped `sep` and undo the escapes (\n \, \; \\). */
export function splitValue(v: string, sep = ";"): string[] {
  const parts: string[] = [];
  let cur = "";
  for (let i = 0; i < v.length; i++) {
    const ch = v[i];
    if (ch === "\\" && i + 1 < v.length) {
      const nx = v[i + 1];
      cur += nx === "n" || nx === "N" ? "\n" : nx;
      i++;
      continue;
    }
    if (ch === sep) { parts.push(cur); cur = ""; continue; }
    cur += ch;
  }
  parts.push(cur);
  return parts;
}

const unescape = (v: string) => splitValue(v, "\u0000")[0];

function textOf(p: Prop): string {
  const enc = p.params.ENCODING?.[0];
  if (enc === "quoted-printable") return decodeQp(p.value, p.params.CHARSET?.[0]);
  return p.value;
}

/** "_$!<Mother>!$_" → "Mother"; other labels as written. */
export function cleanLabel(s: string): string {
  return s.replace(/^_\$!<(.*)>!\$_$/, "$1").trim();
}

const SKIP_TYPES = new Set(["pref", "internet", "voice", "x400", "msg", "text", "uri"]);
function typeLabel(p: Prop, groupLabels: Map<string, string>): string | undefined {
  if (p.group && groupLabels.has(p.group)) return groupLabels.get(p.group);
  const t = (p.params.TYPE ?? []).find((x) => !SKIP_TYPES.has(x));
  return t || undefined;
}

/** Android's relation codes (ContactsContract.CommonDataKinds.Relation). */
const ANDROID_RELATION: Record<string, string> = {
  "1": "assistant", "2": "brother", "3": "child", "4": "domestic partner", "5": "father", "6": "friend", "7": "manager",
  "8": "mother", "9": "parent", "10": "partner", "11": "referred by", "12": "relative", "13": "sister", "14": "spouse",
};

const SPOUSE_PROPS = new Set(["X-EVOLUTION-SPOUSE", "X-KADDRESSBOOK-X-SPOUSENAME", "X-SPOUSE", "X-MS-SPOUSE"]);

type Card = { props: Prop[] };

function cardToContact(card: Card, index: number): RawContact & { uid: string | null; isOrg: boolean; relatedUids: { label: string; uid: string }[] } {
  const groupLabels = new Map<string, string>();
  for (const p of card.props) if (p.name === "X-ABLABEL" && p.group) groupLabels.set(p.group, cleanLabel(unescape(textOf(p))));
  const one = (name: string) => card.props.find((p) => p.name === name);
  const all = (name: string) => card.props.filter((p) => p.name === name);

  const fn = one("FN") ? unescape(textOf(one("FN")!)).trim() : "";
  const n = one("N") ? splitValue(textOf(one("N")!)).map((x) => x.trim()) : [];
  const [family = "", given = "", additional = ""] = n;
  const org = one("ORG") ? splitValue(textOf(one("ORG")!)).map((x) => x.trim()).filter(Boolean)[0] ?? "" : "";
  const showAs = one("X-ABSHOWAS") ? textOf(one("X-ABSHOWAS")!).trim().toUpperCase() : "";
  const kind = one("KIND") ? textOf(one("KIND")!).trim().toLowerCase() : "";
  const isOrg = !!org && (showAs === "COMPANY" || kind === "org" || kind === "organization" || (!given && !family && (!fn || fn === org)));
  const personName = fn || [given, additional, family].filter(Boolean).join(" ");
  const name = isOrg ? org : personName;

  let nickname = one("NICKNAME") ? splitValue(textOf(one("NICKNAME")!), ",")[0]?.trim() : undefined;
  const related: { label: string; name: string }[] = [];
  const relatedUids: { label: string; uid: string }[] = [];

  for (const p of all("X-ABRELATEDNAMES")) {
    const v = unescape(textOf(p)).trim();
    const label = typeLabel(p, groupLabels) ?? "related";
    if (v) related.push({ label, name: v });
  }
  for (const p of all("RELATED")) {
    const v = unescape(textOf(p)).trim();
    const label = (p.params.TYPE ?? []).find((x) => x !== "pref") ?? (p.group ? groupLabels.get(p.group) : undefined) ?? "related";
    if (!v) continue;
    const isText = p.params.VALUE?.[0] === "text" || !/^[a-z][a-z0-9+.-]*:/i.test(v);
    if (isText) related.push({ label, name: v });
    else if (/^urn:uuid:/i.test(v)) relatedUids.push({ label, uid: v.replace(/^urn:uuid:/i, "").toLowerCase() });
  }
  for (const p of card.props) {
    if (SPOUSE_PROPS.has(p.name)) { const v = unescape(textOf(p)).trim(); if (v) related.push({ label: "spouse", name: v }); }
  }
  for (const p of all("X-ANDROID-CUSTOM")) {
    const parts = splitValue(textOf(p));
    if (parts[0] === "vnd.android.cursor.item/relation" && parts[1]?.trim()) {
      const code = parts[2]?.trim() ?? "";
      related.push({ label: code === "0" ? (parts[3]?.trim() || "related") : (ANDROID_RELATION[code] ?? "related"), name: parts[1].trim() });
    }
    if (parts[0] === "vnd.android.cursor.item/nickname" && parts[1]?.trim() && !nickname) nickname = parts[1].trim();
  }

  const bdayProp = one("BDAY");
  const birthday = bdayProp ? normBirthday(unescape(textOf(bdayProp)), bdayProp.params["X-APPLE-OMIT-YEAR"]?.[0] ?? null) : null;

  const addresses = all("ADR").map((p) => {
    const [, ext = "", street = "", city = "", region = "", postal = "", country = ""] = splitValue(textOf(p)).map((x) => x.trim());
    return { label: typeLabel(p, groupLabels), street: [street, ext].filter(Boolean).join(", "), city: city || region, postalCode: postal, country };
  });
  // Home first: the address that describes where someone lives.
  addresses.sort((a, b) => Number(b.label === "home") - Number(a.label === "home"));

  const note = one("NOTE") ? unescape(textOf(one("NOTE")!)) : undefined;
  const title = one("TITLE") ? unescape(textOf(one("TITLE")!)).trim() : undefined;
  const uidProp = one("UID");
  const uid = uidProp ? unescape(textOf(uidProp)).trim().replace(/^urn:uuid:/i, "").toLowerCase() : null;

  return {
    id: uid ? uid.slice(0, 200) : `card-${index + 1}`,
    name,
    givenName: isOrg ? null : given,
    familyName: isOrg ? null : family,
    nickname,
    emails: all("EMAIL").map((p) => ({ label: typeLabel(p, groupLabels), value: unescape(textOf(p)).replace(/^mailto:/i, "").trim() })),
    phones: all("TEL").map((p) => ({ label: typeLabel(p, groupLabels), value: unescape(textOf(p)).replace(/^tel:/i, "").trim() })),
    birthday,
    addresses,
    // A company card keeps its name as the organisation too (name === organization, no given/family name).
    organization: org,
    jobTitle: isOrg ? null : title,
    related,
    note,
    uid,
    isOrg,
    relatedUids,
  };
}

/** Every card in a vCard file, as contacts (at most `max`). Cards with no name and nothing else are still returned. */
export function parseVCards(text: string, opts: { max?: number } = {}): { contacts: Contact[]; cards: number } {
  const max = opts.max ?? 20_000;
  const cards: Card[] = [];
  let cur: Card | null = null;
  let depth = 0;
  for (const line of unfold(text)) {
    if (!line.trim()) continue;
    const p = parseLine(line);
    if (!p) continue;
    if (p.name === "BEGIN" && p.value.trim().toUpperCase() === "VCARD") {
      depth++;
      if (depth === 1) cur = { props: [] };
      continue;
    }
    if (p.name === "END" && p.value.trim().toUpperCase() === "VCARD") {
      depth = Math.max(0, depth - 1);
      if (depth === 0 && cur) { cards.push(cur); cur = null; if (cards.length >= max) break; }
      continue;
    }
    if (!cur || depth !== 1) continue;
    if (p.name === "PHOTO" || p.name === "LOGO" || p.name === "SOUND" || p.name === "KEY") continue;
    cur.props.push(p);
  }
  const raw = cards.map(cardToContact);
  const byUid = new Map<string, string>();
  for (const c of raw) if (c.uid && c.name) byUid.set(c.uid, c.name);
  const seenIds = new Set<string>();
  const contacts = raw.map((c, i) => {
    const related = [...(c.related ?? [])];
    for (const r of c.relatedUids) { const nm = byUid.get(r.uid); if (nm) related.push({ label: r.label, name: nm }); }
    // Ids must be unique within a batch (two cards with the same UID: keep the second as its own card).
    const id = seenIds.has(c.id) ? `${c.id.slice(0, 180)}#${i + 1}` : c.id;
    seenIds.add(id);
    return clampContact({ ...c, id, related });
  });
  return { contacts, cards: cards.length };
}
