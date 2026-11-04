/**
 * Synonym detection for the emergent meta model (pure). Before a new kind or relation is proposed, we look for one the
 * graph already has under another name: the same word in another form (plural, Danish, a typo), or a known synonym
 * ("dept" → Department, "customer" → Client, "working on" → works on).
 */
import type { MetaKind, MetaModel, MetaRelation } from "./types";

const DIACRITICS: Record<string, string> = { æ: "ae", ø: "oe", å: "aa", ä: "a", ö: "o", ü: "u", é: "e", è: "e" };

/** A comparable form of a term: lowercase, Danish letters folded, articles dropped, simple plurals singularised. */
export function normalizeTerm(s: string): string {
  let t = s.toLowerCase().trim().replace(/[æøåäöüéè]/g, (c) => DIACRITICS[c] ?? c).normalize("NFKD").replace(/[̀-ͯ]/g, "");
  t = t.replace(/[_\-./]+/g, " ").replace(/[^a-z0-9 ]+/g, "").replace(/\s+/g, " ").trim();
  t = t.replace(/^(the|a|an|en|et|den|det)\s+/, "");
  return t.split(" ").map(singular).join(" ");
}

function singular(w: string): string {
  if (w.length <= 3) return w;
  if (w.endsWith("ies") && w.length > 4) return w.slice(0, -3) + "y";
  if (/(ss|us|is)$/.test(w)) return w;
  if (/(sses|xes|ches|shes)$/.test(w)) return w.slice(0, -2);
  if (w.endsWith("s")) return w.slice(0, -1);
  return w;
}

/** snake_case key for a label ("Architecture Enablement" → architecture_enablement), valid for the meta tables. */
export function toKey(label: string): string {
  const k = label.toLowerCase().replace(/æ/g, "ae").replace(/ø/g, "oe").replace(/å/g, "aa").normalize("NFKD")
    .replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 44);
  return k ? (/^[a-z]/.test(k) ? k : `x_${k}`) : "thing";
}

/** "department" → "Department", keeps acronyms ("EAM") and inner capitals. */
export function titleCase(s: string): string {
  const t = s.trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}

/** Simple English plural for a kind label. */
export function pluralize(label: string): string {
  const t = label.trim();
  if (/[^aeiou]y$/i.test(t)) return t.slice(0, -1) + "ies";
  if (/(s|x|ch|sh)$/i.test(t)) return t + "es";
  return t + "s";
}

/** Groups of words that name the same kind of thing (normalised forms). */
const KIND_SYNONYMS: string[][] = [
  ["department", "dept", "division", "afdeling", "unit", "business unit", "enhed"],
  ["team", "squad", "crew", "hold", "gruppe", "group"],
  ["project", "projekt", "initiative", "programme", "program", "undertaking"],
  ["company", "firm", "business", "virksomhed", "firma", "corporation", "enterprise"],
  ["client", "customer", "kunde"],
  ["supplier", "vendor", "leverandoer", "provider"],
  ["meeting", "moede", "call", "sync"],
  ["deadline", "frist", "due date"],
  ["system", "application", "app", "platform", "tool", "software"],
  ["colleague", "coworker", "co worker", "kollega"],
  ["manager", "boss", "chef", "leder", "line manager"],
  ["association", "club", "forening", "klub", "union"],
  ["goal", "objective", "maal", "target"],
  ["deliverable", "leverance", "output"],
  ["risk", "risiko"],
  ["workstream", "work stream", "track", "spor"],
  ["school", "skole"],
  ["doctor", "laege", "gp", "physician"],
  ["friend", "ven", "veninde"],
  ["wish", "gift idea", "oenske"],
];

/** Groups of relation phrasings that mean the same edge (normalised forms of label or key). */
const RELATION_SYNONYMS: string[][] = [
  ["work on", "works on", "working on", "contribute to", "contributes to", "arbejder paa", "is on", "on project"],
  ["member of", "is member of", "is in", "part of team", "medlem af", "work in", "works in", "works at", "employed by", "work for", "ansat i"],
  ["belong to", "belongs to", "part of", "is part of", "under", "hoerer under", "owned by", "run by", "falls under"],
  ["lead", "leads", "manages project", "is lead of", "lead of", "heads", "leder"],
  ["depend on", "depends on", "needs", "requires", "afhaenger af"],
  ["report to", "reports to", "refererer til"],
  ["know", "knows", "kender"],
  ["friend of", "friends with", "ven med"],
  ["located at", "located in", "is in place", "ligger i", "based in"],
];

/** Is this word one of the kind words we know (department, team, project, kunde …)? */
export function isKnownKindWord(w: string): boolean {
  return groupOf(KIND_SYNONYMS, w) >= 0;
}

function groupOf(groups: string[][], term: string): number {
  const n = normalizeTerm(term);
  return groups.findIndex((g) => g.some((w) => normalizeTerm(w) === n));
}

/** Edit distance (Levenshtein), capped for speed. */
export function editDistance(a: string, b: string, cap = 3): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, cur[j]);
    }
    if (best > cap) return cap + 1;
    prev = cur;
  }
  return prev[b.length];
}

export type SynonymReason = "same" | "synonym" | "spelling";

/** Are two terms the same thing? "same" (equal once normalised), "synonym" (a known pair) or "spelling" (a typo). */
export function sameTerm(a: string, b: string, groups: string[][] = KIND_SYNONYMS, opts: { spelling?: boolean } = {}): SynonymReason | null {
  const na = normalizeTerm(a), nb = normalizeTerm(b);
  if (!na || !nb) return null;
  if (na === nb) return "same";
  const ga = groupOf(groups, a);
  if (ga >= 0 && ga === groupOf(groups, b)) return "synonym";
  const minLen = Math.min(na.length, nb.length);
  if (opts.spelling !== false && minLen >= 5 && editDistance(na, nb, 2) <= (minLen >= 9 ? 2 : 1)) return "spelling";
  return null;
}

const RANK: Record<SynonymReason, number> = { same: 0, synonym: 1, spelling: 2 };

/**
 * The kind this label already names in the model, if any: compares label, plural and key. Prefers the given node
 * type, then any type. Hidden (off-template) built-ins count, so they are reused rather than duplicated.
 */
export function findSynonymKind(m: Pick<MetaModel, "kinds">, label: string, nodeType?: string): { kind: MetaKind; reason: SynonymReason } | null {
  let best: { kind: MetaKind; reason: SynonymReason; score: number } | null = null;
  for (const k of m.kinds) {
    if (k.hidden && !k.offTemplate) continue; // the household hid it on purpose
    for (const name of [k.label, k.pluralLabel, k.key].filter(Boolean) as string[]) {
      const r = sameTerm(label, name);
      if (!r) continue;
      const score = RANK[r] * 10 + (nodeType && k.nodeType !== nodeType ? 5 : 0) + (k.offTemplate ? 1 : 0);
      if (!best || score < best.score) best = { kind: k, reason: r, score };
    }
  }
  return best ? { kind: best.kind, reason: best.reason } : null;
}

/**
 * The relation type this phrasing already names, and in which direction: "out" when it matches the label,
 * "in" when it matches the inverse ("worked on by" → works_on read backwards).
 */
export function findSynonymRelation(m: Pick<MetaModel, "relations">, phrase: string): { relation: MetaRelation; direction: "out" | "in"; reason: SynonymReason } | null {
  let best: { relation: MetaRelation; direction: "out" | "in"; reason: SynonymReason; score: number } | null = null;
  for (const r of m.relations) {
    if (r.hidden && !r.offTemplate) continue;
    const forms: [string, "out" | "in"][] = [[r.label, "out"], [r.key, "out"]];
    if (!r.symmetric) forms.push([r.inverseLabel, "in"]);
    for (const [name, direction] of forms) {
      const reason = sameTerm(phrase, name, RELATION_SYNONYMS, { spelling: false });
      if (!reason) continue;
      const score = RANK[reason] * 10 + (direction === "in" ? 1 : 0) + (r.offTemplate ? 2 : 0);
      if (!best || score < best.score) best = { relation: r, direction, reason, score };
    }
  }
  return best ? { relation: best.relation, direction: best.direction, reason: best.reason } : null;
}

/** Pairs among candidate labels that are probably the same thing (for "Merge into …" suggestions). */
export function synonymPairs(labels: { id: string; label: string }[]): { a: string; b: string; reason: SynonymReason }[] {
  const out: { a: string; b: string; reason: SynonymReason }[] = [];
  for (let i = 0; i < labels.length; i++) for (let j = i + 1; j < labels.length; j++) {
    const r = sameTerm(labels[i].label, labels[j].label);
    if (r) out.push({ a: labels[i].id, b: labels[j].id, reason: r });
  }
  return out;
}
