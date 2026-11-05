/**
 * Putting the three tiers together (pure, shared by the composer and the old POST /api/annotate).
 *
 * Inputs: the text, its sentences with whatever the model said about each (positions relative to the sentence),
 * names from the graph found by the instant matcher, @mentions the person picked, the whole-text facts pass, and the
 * deterministic details. Output: one `DomainPlan` (what Send would add) and the spans to paint.
 *
 * Refs are stable across sentences and requests: `n:<nodeId>` for things in the graph, `x:<folded label>` for new
 * things, `you` for the writer. So a name in two sentences is one entity, and facts from any pass line up.
 */
import { DOMAIN_NODE_TYPES, type DomainPlan, type PlannedEntity, type PlannedFact, type PlannedKind, type PlannedRelation } from "@/lib/meta/domain";
import type { MetaNodeType } from "@/lib/meta/types";
import { findWord } from "../markup";
import type { Detail } from "./detect";
import { foldName, type LexMatch } from "./matcher";
import { hash53, type Sentence } from "./sentences";

/** A thing the model found in one sentence; `at`/`len` locate its words in that sentence. */
export type SentenceEntity = Omit<PlannedEntity, "ref"> & { ref: string; at: number; len: number };
export type SentenceResult = {
  key: string;
  /** The sentence as read (to relocate the result while the sentence is being edited). */
  text: string;
  entities: SentenceEntity[];
  facts: PlannedFact[];
  kinds: PlannedKind[];
  relations: PlannedRelation[];
};
export type FactsResult = { facts: PlannedFact[]; relations: PlannedRelation[] };

export type LiveTone = "existing" | "new" | "newKind" | "mention" | "detail" | "maybe";
export type LiveSpan = { ref: string; start: number; end: number; text: string; type: string; tone: LiveTone; tag: string; detail?: Detail["kind"] };

export const nodeRef = (id: string) => `n:${id}`;
/** A stable ref for a new thing, from its label (short enough for the commit schema). */
export function newRef(label: string): string {
  const f = foldName(label).replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "");
  return f.length <= 40 ? `x:${f}` : `x:${f.slice(0, 30)}-${hash53(f)}`;
}

/**
 * Keep a sentence's old result while the sentence is being edited: each thing stays if its words are still there
 * (found again near where it was), else it is dropped. Facts whose ends are gone go too.
 */
export function relocateResult(r: SentenceResult, text: string): SentenceResult {
  if (r.text === text) return r;
  const entities: SentenceEntity[] = [];
  for (const e of r.entities) {
    const words = r.text.slice(e.at, e.at + e.len);
    let i = findWord(text, words, Math.max(0, e.at - 40));
    if (i < 0) i = findWord(text, words);
    if (i < 0) continue;
    entities.push({ ...e, at: i, len: words.length });
  }
  const refs = new Set(["you", ...entities.map((e) => e.ref)]);
  return { ...r, text, entities, facts: r.facts.filter((f) => refs.has(f.from) && refs.has(f.to)) };
}

export function tagFor(e: Pick<PlannedEntity, "existing" | "newKind" | "label" | "kindLabel" | "type">): { tone: LiveTone; tag: string } {
  if (e.existing) return { tone: "existing", tag: `links to ${e.label}` };
  if (e.newKind) return { tone: "newKind", tag: `new kind: ${e.kindLabel}` };
  return { tone: "new", tag: `new ${e.kindLabel ?? e.type}` };
}

export type MergeInput = {
  text: string;
  sentences: Sentence[];
  /** Aligned with `sentences`: the result for each (possibly relocated from an older version), or null. */
  results: (SentenceResult | null)[];
  /** Graph names found in the text (the viewer's own node already left out). */
  links: LexMatch[];
  /** @mentions the person picked, located in the text. */
  mentions?: { start: number; end: number; nodeId: string; label: string; type: string }[];
  /** Labels the person chose to create from the @ menu. */
  created?: string[];
  facts?: FactsResult | null;
  details?: Detail[];
  maybe?: Detail[];
  /** Read-only graph: only links. */
  linksOnly?: boolean;
};

export type MergeOutput = { plan: DomainPlan; spans: LiveSpan[] };

/** Documents and other non-domain things can be linked, but travel in a plan as "thing". */
const domainType = (t: string): MetaNodeType => ((DOMAIN_NODE_TYPES as readonly string[]).includes(t) ? t : "thing") as MetaNodeType;

const overlaps = (a: { start: number; end: number }, xs: { start: number; end: number }[]) => xs.some((x) => a.start < x.end && a.end > x.start);

export function mergeLive(input: MergeInput): MergeOutput {
  const { text } = input;
  const entities = new Map<string, PlannedEntity>();
  const spans: LiveSpan[] = [];
  const taken: { start: number; end: number }[] = [];
  const claim = (ref: string, start: number, end: number, tone: LiveTone, type: string, tag: string) => {
    if (end > text.length || start < 0 || end <= start || overlaps({ start, end }, taken)) return false;
    taken.push({ start, end });
    spans.push({ ref, start, end, text: text.slice(start, end), type, tone, tag });
    return true;
  };

  // 1. What the person picked with @.
  for (const m of input.mentions ?? []) {
    const ref = nodeRef(m.nodeId);
    if (claim(ref, m.start, m.end, "mention", m.type, "") && !entities.has(ref)) {
      entities.set(ref, { ref, label: m.label, surface: text.slice(m.start, m.end), type: domainType(m.type), kindKey: null, kindLabel: null, newKind: false, nodeId: m.nodeId, existing: true });
    }
  }

  // 2. Names already in the graph (instant).
  for (const l of input.links) {
    const ref = nodeRef(l.entry.id);
    const e: PlannedEntity = entities.get(ref) ?? { ref, label: l.entry.label, surface: l.text, type: domainType(l.entry.type), kindKey: l.entry.kind ?? null, kindLabel: l.entry.kindLabel ?? null, newKind: false, nodeId: l.entry.id, existing: true };
    if (claim(ref, l.start, l.end, "existing", e.type, `links to ${e.label}`)) entities.set(ref, e);
  }

  // 3. What the model found, sentence by sentence (in text order, whatever order the answers arrived in).
  const facts = new Map<string, PlannedFact>();
  const kinds = new Map<string, PlannedKind>();
  const relations = new Map<string, PlannedRelation>();
  if (!input.linksOnly) {
    input.sentences.forEach((s, i) => {
      const r = input.results[i];
      if (!r) return;
      for (const e of r.entities) {
        const start = s.start + e.at, end = start + e.len;
        const prior = entities.get(e.ref);
        const ent: PlannedEntity = prior ?? { ref: e.ref, label: e.label, surface: text.slice(start, end), type: e.type, kindKey: e.kindKey, kindLabel: e.kindLabel, newKind: e.newKind, nodeId: e.nodeId, existing: e.existing };
        const { tone, tag } = tagFor(ent);
        if (claim(e.ref, start, end, tone, ent.type, tag) && !prior) entities.set(e.ref, ent);
      }
      for (const k of r.kinds) kinds.set(`${k.nodeType}:${k.key}`, kinds.get(`${k.nodeType}:${k.key}`) ?? k);
      for (const rel of r.relations) relations.set(rel.key, relations.get(rel.key) ?? rel);
      for (const f of r.facts) { const key = `${f.from}|${f.relationKey}|${f.to}`; if (!facts.has(key)) facts.set(key, f); }
    });
    for (const f of input.facts?.facts ?? []) { const key = `${f.from}|${f.relationKey}|${f.to}`; if (!facts.has(key)) facts.set(key, f); }
    for (const rel of input.facts?.relations ?? []) relations.set(rel.key, relations.get(rel.key) ?? rel);

    // 4. Things the person chose to create from the @ menu.
    for (const c of input.created ?? []) {
      const ref = newRef(c);
      if (entities.has(ref)) continue;
      let i = findWord(text, `@${c}`);
      let len = c.length + 1;
      if (i < 0) { i = findWord(text, c); len = c.length; }
      if (i < 0) continue;
      const e: PlannedEntity = { ref, label: c, surface: text.slice(i, i + len), type: "thing", kindKey: null, kindLabel: null, newKind: false, nodeId: null, existing: false };
      if (claim(ref, i, i + len, "new", "thing", "new thing")) entities.set(ref, e);
    }
  }

  // 5. Details and "maybe new" marks fill what is left; they are never part of the plan.
  if (!input.linksOnly) {
    for (const d of input.details ?? []) {
      if (overlaps(d, taken)) continue;
      taken.push(d);
      spans.push({ ref: `d:${d.start}`, start: d.start, end: d.end, text: d.text, type: "detail", tone: "detail", tag: "", detail: d.kind });
    }
    for (const d of input.maybe ?? []) {
      if (!overlaps(d, taken)) spans.push({ ref: `m:${d.start}`, start: d.start, end: d.end, text: d.text, type: "thing", tone: "maybe", tag: "", detail: d.kind });
    }
  }

  const ents = [...entities.values()];
  const refs = new Set(["you", ...ents.map((e) => e.ref)]);
  const keptFacts = [...facts.values()].filter((f) => refs.has(f.from) && refs.has(f.to) && f.from !== f.to)
    .map((f, i) => ({ ...f, ref: `f${i + 1}` }));
  const keptKinds = [...kinds.values()].filter((k) => ents.some((e) => e.kindKey === k.key && e.type === k.nodeType));
  const keptRelations = [...relations.values()].filter((r) => keptFacts.some((f) => f.relationKey === r.key));
  return {
    plan: { kinds: keptKinds, relations: keptRelations, entities: ents, facts: keptFacts, attributes: [] },
    spans: spans.sort((a, b) => a.start - b.start),
  };
}
