/**
 * Shared by the notes importers (Apple Notes, Obsidian, Notion). Pure.
 *
 * A note is one searchable segment (its locator names the note). A note that names a person unambiguously (a
 * [[link]] to a person's note, or a person's full name as the graph knows it when no one else shares it) gets its own
 * document node in the graph, proposed with a "mentions" link to each person. Notes already brought in before (same
 * note id) reuse their node and only gain the links they lack.
 */
import { roleMention } from "@/lib/meta/roles";
import type { ChangeInput } from "@/lib/changes";
import type { TextSegment } from "@/lib/ingest/chunk";
import { BUILTIN_RELATIONS } from "@/lib/meta/builtins";
import { edgeKey, matchPerson, normName } from "../match";
import type { ImportContext, ImportKnown } from "../types";

function relation(key: string): string {
  if (!BUILTIN_RELATIONS.some((r) => r.key === key)) throw new Error(`Unknown relation ${key}`);
  return key;
}
export const MENTIONS = relation("mentions");

export const NOTE_RULES = {
  /** Document nodes proposed for notes from one import at most. */
  maxNoteNodes: 500,
  /** Names shorter than this are never matched in free text. */
  minNameLength: 3,
};

export type Note = {
  /** Stable id at the source (Apple's note id, the vault path, Notion's 32-hex id). */
  key: string;
  title: string;
  /** Where the note sits ("Notes/Familie", "Vault/Daily"), for the locator. */
  where?: string | null;
  text: string;
  createdAt?: Date | null;
  updatedAt?: Date | null;
  /** A day the note is about (a daily note). */
  day?: string | null;
  /** Explicit links to people: names as written in [[links]] (resolved against `people`). */
  links?: string[];
};

/** People an import can link to: known ones and the ones it proposes itself, by normalised name. */
export type PersonIndex = Map<string, string>;

/** The note's locator region: "Familie / Indkøb" or the path. */
export const noteRegion = (n: Note) => (n.where ? `${n.where} / ${n.title}` : n.title);

export function noteSegment(n: Note, header: string[] = []): TextSegment {
  const lines = [n.title, ...header.filter(Boolean)];
  return { text: `${lines.join("\n")}\n\n${n.text.trim()}`.trim(), at: { region: noteRegion(n) } };
}

/* ── Names in free text ───────────────────────────────────────────────────────────────────────────────────── */

type NameCandidate = { text: string; id: string };

/**
 * Person names usable in free text: labels and aliases of known people that belong to exactly one person (and are at
 * least `minNameLength` long). Matched case-sensitively as written, on word boundaries.
 */
export function nameCandidates(known: ImportKnown[]): NameCandidate[] {
  const byName = new Map<string, { ids: Set<string>; spellings: Set<string> }>();
  for (const k of known) {
    if (k.type !== "person") continue;
    for (const name of [k.label, ...k.aliases]) {
      const n = normName(name);
      if (n.length < NOTE_RULES.minNameLength) continue;
      const e = byName.get(n) ?? { ids: new Set(), spellings: new Set() };
      e.ids.add(k.id);
      e.spellings.add(name.trim());
      byName.set(n, e);
    }
  }
  const out: NameCandidate[] = [];
  for (const e of byName.values()) if (e.ids.size === 1) for (const s of e.spellings) out.push({ text: s, id: [...e.ids][0] });
  // Longest first, so "Ida Hansen" wins over "Ida".
  return out.sort((a, b) => b.text.length - a.text.length);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Known people named in a text: person id → the line that names them. */
export function namesIn(text: string, candidates: NameCandidate[]): Map<string, string> {
  const found = new Map<string, string>();
  const taken: [number, number][] = [];
  const words = new Set(text.split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  for (const c of candidates) {
    const first = c.text.split(/[^\p{L}\p{N}]+/u).find(Boolean);
    if (!first || !words.has(first)) continue;
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(c.text)}(?![\\p{L}\\p{N}])`, "gu");
    for (const m of text.matchAll(re)) {
      const start = m.index ?? 0;
      const end = start + m[0].length;
      if (taken.some(([a, b]) => start < b && end > a)) continue;
      taken.push([start, end]);
      if (!found.has(c.id)) found.set(c.id, lineAround(text, start, end));
    }
  }
  return found;
}

export function lineAround(text: string, start: number, end: number): string {
  const a = text.lastIndexOf("\n", start) + 1;
  const b = text.indexOf("\n", end);
  const line = text.slice(a, b < 0 ? text.length : b).trim();
  if (line.length <= 240) return line;
  const from = Math.max(0, start - a - 100);
  return line.slice(from, from + 240).trim();
}

/* ── Proposals ────────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * For notes that name people: a document node per note (or the one an earlier import made) and a "mentions" edge
 * to each person. `people` maps a normalised name to a person id (known or proposed in this plan) for [[links]].
 */
export function linkNotesToPeople(
  notes: Note[], ctx: ImportContext, opts: { app: string; people?: PersonIndex; propKey: string; skipSelf?: boolean },
): { changes: ChangeInput[]; notesLinked: number; links: number; warnings: string[] } {
  const candidates = nameCandidates(ctx.known);
  const docs = new Map<string, string>();
  for (const k of ctx.known) if (k.type === "document" && typeof k.props[opts.propKey] === "string") docs.set(k.props[opts.propKey] as string, k.id);
  const changes: ChangeInput[] = [];
  const warnings: string[] = [];
  let notesLinked = 0;
  let links = 0;
  let capped = 0;
  for (const n of notes) {
    const hits = namesIn(n.text, candidates);
    for (const l of n.links ?? []) {
      const id = opts.people?.get(normName(l));
      if (id && !hits.has(id)) {
        const at = n.text.indexOf(l);
        hits.set(id, at >= 0 ? lineAround(n.text, at, at + l.length) : n.title);
      }
    }
    if (opts.skipSelf !== false) {
      const self = opts.people?.get(normName(n.title)) ?? candidates.find((c) => normName(c.text) === normName(n.title))?.id;
      if (self) hits.delete(self);
    }
    if (!hits.size) continue;
    let docId = docs.get(n.key);
    const region = noteRegion(n);
    if (!docId) {
      if (notesLinked >= NOTE_RULES.maxNoteNodes) { capped++; continue; }
      docId = ctx.mint();
      const startAt = n.day ? `${n.day}T12:00:00.000Z` : (n.createdAt ?? n.updatedAt)?.toISOString() ?? null;
      changes.push({
        op: "addNode", nodeId: docId, type: "document", label: n.title.slice(0, 200) || "Untitled note",
        props: { sourceId: ctx.sourceId, [opts.propKey]: n.key, kind: "note" }, startAt, visibility: ctx.visibility,
        note: `A note from ${opts.app} that names ${hits.size === 1 ? "a person" : `${hits.size} people`} in the graph.`,
        receipt: { sourceId: ctx.sourceId, quote: n.title.slice(0, 240), locator: { region } },
      });
    }
    notesLinked++;
    for (const [personId, quote] of hits) {
      if (ctx.existingEdges.has(edgeKey(docId, MENTIONS, personId))) continue;
      changes.push({
        op: "addEdge", edgeId: ctx.mint(), fromId: docId, toId: personId, relation: MENTIONS, confidence: 0.9,
        note: `Named in the note “${n.title.slice(0, 120)}”.`, receipt: { sourceId: ctx.sourceId, quote, locator: { region } },
      });
      links++;
    }
  }
  if (capped) warnings.push(`${capped} more notes name people but were not linked (at most ${NOTE_RULES.maxNoteNodes} per import).`);
  return { changes, notesLinked, links, warnings };
}

/* ── Frontmatter (the small YAML subset notes use) ────────────────────────────────────────────────────────── */

export type Frontmatter = Record<string, string | string[]>;

const unquote = (s: string) => s.trim().replace(/^(["'])([\s\S]*)\1$/, "$2").trim();

/** Split "---\nkey: value\n---\nbody" into its fields and the body. */
export function splitFrontmatter(md: string): { fm: Frontmatter; body: string; raw: string } {
  const m = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(md);
  if (!m) return { fm: {}, body: md, raw: "" };
  const fm: Frontmatter = {};
  let listKey: string | null = null;
  for (const line of m[1].split(/\r?\n/)) {
    const item = /^\s+-\s+(.*)$/.exec(line) ?? /^-\s+(.*)$/.exec(line);
    if (item && listKey) {
      const cur = fm[listKey];
      fm[listKey] = [...(Array.isArray(cur) ? cur : cur ? [cur] : []), unquote(item[1])].filter(Boolean);
      continue;
    }
    const kv = /^([A-Za-z0-9_æøåÆØÅ -]+?)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1].trim().toLowerCase();
    const value = kv[2].trim();
    if (!value) { listKey = key; fm[key] = []; continue; }
    listKey = null;
    const list = /^\[(.*)\]$/.exec(value);
    fm[key] = list ? list[1].split(",").map(unquote).filter(Boolean) : unquote(value);
  }
  return { fm, body: md.slice(m[0].length), raw: m[0] };
}

export const fmList = (v: string | string[] | undefined): string[] => (Array.isArray(v) ? v : v ? v.split(/[,\s]+/).filter(Boolean) : []);
export const fmText = (v: string | string[] | undefined): string | null => (Array.isArray(v) ? v[0] ?? null : v ?? null);

/* ── Dates people write ───────────────────────────────────────────────────────────────────────────────────── */

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, januar: 1, feb: 2, february: 2, februar: 2, mar: 3, march: 3, marts: 3, apr: 4, april: 4, may: 5, maj: 5,
  jun: 6, june: 6, juni: 6, jul: 7, july: 7, juli: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, okt: 10,
  october: 10, oktober: 10, nov: 11, november: 11, dec: 12, december: 12,
};
const two = (n: number) => String(n).padStart(2, "0");

/** "1948-05-02", "May 2, 1948", "2. maj 1948", "02/05/1948" (day first) → "1948-05-02"; anything else → null. */
export function parseDay(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = s.trim();
  let y: number, mo: number, d: number;
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(t);
  if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; }
  else if ((m = /^([A-Za-zæøå]+)\.? (\d{1,2}),? (\d{4})/.exec(t)) && MONTHS[m[1].toLowerCase()]) { mo = MONTHS[m[1].toLowerCase()]; d = +m[2]; y = +m[3]; }
  else if ((m = /^(\d{1,2})\.? ([A-Za-zæøå]+)\.? (\d{4})/.exec(t)) && MONTHS[m[2].toLowerCase()]) { d = +m[1]; mo = MONTHS[m[2].toLowerCase()]; y = +m[3]; }
  else if ((m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/.exec(t))) { d = +m[1]; mo = +m[2]; y = +m[3]; }
  else return null;
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 1800 || y > 2200) return null;
  return `${y}-${two(mo)}-${two(d)}`;
}

/* ── People found as notes or rows (Obsidian person notes, a Notion people database) ─────────────────────── */

export type PersonFound = {
  name: string;
  aliases?: string[];
  /** Attribute values in the graph's keys: birthday ("YYYY-MM-DD"), email, phone, address, notes … */
  props?: Record<string, string>;
  quote: string;
  region: string;
  /** Propose them when the graph doesn't know them (a note typed person, a row of a people database). */
  certain: boolean;
};

/**
 * Match each person against the graph (email, phone, unique name). Known ones gain only what they lack (an alias, an
 * empty field), never a changed value; certain unknown ones are proposed. Returns name → person id for links.
 */
export function proposeFoundPeople(found: PersonFound[], ctx: ImportContext, app: string): {
  changes: ChangeInput[]; index: PersonIndex; proposed: number; matched: number; updates: number;
} {
  const changes: ChangeInput[] = [];
  const index: PersonIndex = new Map();
  let proposed = 0, matched = 0, updates = 0;
  const seen = new Set<string>();
  for (const p of found) {
    const n = normName(p.name);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    const props = p.props ?? {};
    const receipt = { sourceId: ctx.sourceId, quote: p.quote.slice(0, 240), locator: { region: p.region } };
    const hit = matchPerson(ctx.known, {
      name: p.name, emails: props.email ? [props.email] : [], phones: props.phone ? [props.phone] : [], birthDate: props.birthday ?? null,
    });
    if (hit) {
      matched++;
      for (const a of [p.name, ...(p.aliases ?? [])]) index.set(normName(a), hit.id);
      const set: Record<string, unknown> = {};
      const fresh: Record<string, string> = {};
      for (const [k, v] of Object.entries(props)) if (v && (hit.props[k] === undefined || hit.props[k] === null || hit.props[k] === "")) fresh[k] = v;
      if (Object.keys(fresh).length) set.props = fresh;
      const have = new Set([hit.label, ...hit.aliases].map(normName));
      const newAliases = [p.name, ...(p.aliases ?? [])].filter((a) => a.trim() && !have.has(normName(a)));
      if (newAliases.length) set.aliases = [...hit.aliases, ...new Set(newAliases.map((a) => a.trim()))];
      if (Object.keys(set).length) {
        changes.push({ op: "updateNode", nodeId: hit.id, set, note: `What ${app} adds about ${hit.label} (only what the graph doesn't hold yet).`, receipt });
        updates++;
      }
      continue;
    }
    if (!p.certain || roleMention(p.name)) continue;
    const id = ctx.mint();
    for (const a of [p.name, ...(p.aliases ?? [])]) index.set(normName(a), id);
    changes.push({
      op: "addNode", nodeId: id, type: "person", label: p.name.trim(), aliases: (p.aliases ?? []).map((a) => a.trim()).filter(Boolean),
      props, visibility: ctx.visibility, note: `A person in ${app}.`, receipt,
    });
    proposed++;
  }
  return { changes, index, proposed, matched, updates };
}

/** Attribute keys people use in notes and databases → the graph's keys. */
export function personPropKey(field: string): "birthday" | "email" | "phone" | "address" | null {
  const f = normName(field).replace(/ø/g, "o").replace(/æ/g, "ae").replace(/å/g, "a");
  if (/^(birthday|birthdate|birth date|born|date of birth|dob|fodselsdag|fodselsdato|fodt)$/.test(f)) return "birthday";
  if (/^(e ?mail|email address|mail|e mail adresse|emailadresse)$/.test(f)) return "email";
  if (/^(phone|phone number|mobile|mobil|cell|telefon|telefonnummer|tlf|tlf nr|mobilnummer)$/.test(f)) return "phone";
  if (/^(address|adresse|home address)$/.test(f)) return "address";
  return null;
}

/** A clean value for a person attribute, or null. */
export function personPropValue(key: "birthday" | "email" | "phone" | "address", raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  if (key === "birthday") return parseDay(v);
  if (key === "email") return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v.toLowerCase() : null;
  if (key === "phone") return v.replace(/\D/g, "").length >= 6 ? v : null;
  return v.slice(0, 300);
}
