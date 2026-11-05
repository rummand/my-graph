/**
 * Reading what someone typed into search. Pure, shared by client and server.
 *
 *   emma                → every section
 *   "permission slip"   → the exact phrase
 *   person: emma        → only people (prefixes in English and Danish, see PREFIXES)
 *   § 16 stk. 2         → a rule reference (matched on refs, not as loose words)
 */
import type { Section } from "./types";

export type NodeKindFilter = "person" | "place" | "organization" | "event" | "topic" | "project" | "thing";
export type MadeKindFilter = "page" | "document" | "deck";

export type TypeFilter = {
  sections: Section[];
  nodeTypes?: NodeKindFilter[];
  madeKinds?: MadeKindFilter[];
  /** The prefix as typed (for the chip in the palette). */
  label: string;
};

const F = (sections: Section[], extra: Omit<TypeFilter, "sections" | "label"> = {}) => ({ sections, ...extra });

/** `prefix:` → what to search. Lower-case, without the colon. */
export const PREFIXES: Record<string, Omit<TypeFilter, "label">> = {
  person: F(["nodes"], { nodeTypes: ["person"] }), people: F(["nodes"], { nodeTypes: ["person"] }), personer: F(["nodes"], { nodeTypes: ["person"] }),
  place: F(["nodes"], { nodeTypes: ["place"] }), sted: F(["nodes"], { nodeTypes: ["place"] }),
  org: F(["nodes"], { nodeTypes: ["organization"] }), organization: F(["nodes"], { nodeTypes: ["organization"] }), organisation: F(["nodes"], { nodeTypes: ["organization"] }),
  topic: F(["nodes"], { nodeTypes: ["topic"] }), emne: F(["nodes"], { nodeTypes: ["topic"] }),
  project: F(["nodes"], { nodeTypes: ["project"] }), projekt: F(["nodes"], { nodeTypes: ["project"] }),
  thing: F(["nodes"]), node: F(["nodes"]), ting: F(["nodes"]),
  event: F(["events"]), events: F(["events"]), begivenhed: F(["events"]), when: F(["events"]), hvornår: F(["events"]),
  page: F(["made"], { madeKinds: ["page"] }), side: F(["made"], { madeKinds: ["page"] }),
  doc: F(["made"], { madeKinds: ["document"] }), document: F(["made"], { madeKinds: ["document"] }), dokument: F(["made"], { madeKinds: ["document"] }),
  deck: F(["made"], { madeKinds: ["deck"] }), slides: F(["made"], { madeKinds: ["deck"] }), præsentation: F(["made"], { madeKinds: ["deck"] }),
  artifact: F(["made"]), made: F(["made"]),
  file: F(["files"]), files: F(["files"]), fil: F(["files"]), filer: F(["files"]), library: F(["files"]), bibliotek: F(["files"]),
  rule: F(["rules"]), rules: F(["rules"]), regel: F(["rules"]), regler: F(["rules"]), law: F(["rules"]), lov: F(["rules"]),
  chat: F(["chats"]), ask: F(["chats"]), samtale: F(["chats"]),
  change: F(["changes"]), changes: F(["changes"]), ændring: F(["changes"]), ændringer: F(["changes"]),
};

export type ParsedQuery = {
  /** The query without its type prefix, whitespace tidied, quotes removed. */
  text: string;
  /** Lower-case words (letters and digits), unique, at most 8. */
  terms: string[];
  /** Quoted phrases, lower-case. */
  phrases: string[];
  filter: TypeFilter | null;
  /** A rule reference ("§ 16", "§ 16 stk. 2", "art. 6"): normalised to "§ 16" / "art. 6" and its sub-parts. */
  ref: { mark: "§" | "art."; number: string; stk: string | null } | null;
};

const WORD = /[\p{L}\p{N}]+/gu;

export function words(s: string): string[] {
  return [...new Set((s.toLowerCase().match(WORD) ?? []))].slice(0, 8);
}

/** Parse a raw query. */
export function parseQuery(raw: string): ParsedQuery {
  let s = (raw ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
  let filter: TypeFilter | null = null;
  const pm = s.match(/^([\p{L}]+):\s*/u);
  if (pm) {
    const key = pm[1].toLowerCase();
    const f = PREFIXES[key];
    if (f) { filter = { ...f, label: pm[1] }; s = s.slice(pm[0].length); }
  }
  const phrases: string[] = [];
  s = s.replace(/"([^"]*)"?/g, (_, p: string) => {
    const t = p.trim();
    if (t) phrases.push(t.toLowerCase());
    return ` ${t} `;
  }).replace(/\s+/g, " ").trim();
  const ref = parseRef(s);
  return { text: s, terms: words(s), phrases, filter, ref };
}

/** "§ 16 stk. 2", "§16, stk 2", "paragraf 16", "art. 6" → the parts. */
export function parseRef(s: string): ParsedQuery["ref"] {
  const m = s.match(/(§|paragraf|art\.?|artikel|article)\s*(\d+\s?[a-z]?)\b(?:[,\s]*(?:stk\.?|stykke)\s*(\d+))?/i);
  if (!m) return null;
  const mark = m[1].startsWith("§") || m[1].toLowerCase() === "paragraf" ? "§" : "art.";
  return { mark, number: m[2].replace(/\s+/g, "").toLowerCase(), stk: m[3] ?? null };
}

/**
 * Postgres regex (case-insensitive, `~*`) for a rule ref: "§ 3" finds "§ 3", "§3, stk. 2", "§ 3 a" but not "§ 30".
 * Only digits and letters from parseRef reach it, so it is safe to inline as a parameter.
 */
export function refRegex(ref: NonNullable<ParsedQuery["ref"]>): string {
  const n = ref.number.replace(/[^0-9a-z]/gi, "");
  const head = ref.mark === "§" ? "§\\s*" : "art(\\.|ikel)?\\s*";
  const tail = ref.stk ? `[^0-9]*stk\\.?\\s*${ref.stk}([^0-9]|$)` : "([^0-9]|$)";
  return `${head}${n}${tail}`;
}

/** The words that should match in text: phrases count as their words, the ref's own tokens are dropped. */
export function textTerms(p: ParsedQuery): string[] {
  if (!p.ref) return p.terms;
  const drop = new Set(["paragraf", "art", "artikel", "article", "stk", "stykke", p.ref.number, p.ref.stk ?? ""]);
  return p.terms.filter((t) => !drop.has(t));
}

/** Prefix tsquery over 'simple' (as GBrain indexes): every word must match as a word prefix. */
export function prefixTsQuery(terms: string[], any = false): string | null {
  const ok = terms.map((t) => t.replace(/[^\p{L}\p{N}]/gu, "")).filter(Boolean);
  return ok.length ? ok.map((w) => `${w}:*`).join(any ? " | " : " & ") : null;
}

/** LIKE pattern for a substring, with %, _ and \ escaped. */
export function likePattern(s: string): string {
  return `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** Whether a query is worth sending to the server at all. */
export function searchable(p: ParsedQuery): boolean {
  return p.text.length >= 1 && (p.terms.length > 0 || !!p.ref);
}

/**
 * Postgres regex (`~*`) for a term at the start of a word. Spelled out instead of \m so Danish letters count as word
 * letters whatever the database locale. Terms are letters and digits only (see `words`); anything else is dropped.
 */
export function wordStartRegex(term: string): string {
  const t = term.replace(/[^\p{L}\p{N}]/gu, "");
  return `(^|[^a-z0-9æøåäöüéèáàíóúñ])${t}`;
}
