/**
 * A small domain model, like DDD, read from a description (pure, safe for client components).
 *
 * The model (through mux) returns an `Extraction`: the entities a text names, their kinds, the relations between them
 * and attributes. `planFromExtraction` maps it onto the graph's meta model: an existing kind or relation is reused when
 * it fits (by name, synonym or spelling), a new one is proposed only when nothing fits, and existing nodes are linked
 * instead of duplicated. `opsFromPlan` turns the plan into change-set ops with a receipt each.
 */
import { KEPT_PERSON_KINDS, detectRole, roleRelation } from "./roles";
import { z } from "zod";
import { findSynonymKind, findSynonymRelation, isKnownKindWord, normalizeTerm, pluralize, sameTerm, titleCase, toKey } from "./synonyms";
import type { MetaModel, MetaNodeType } from "./types";

export const DOMAIN_NODE_TYPES = ["person", "organization", "project", "place", "event", "topic", "thing"] as const;
export type DomainNodeType = (typeof DOMAIN_NODE_TYPES)[number];

const nodeType = z.string().transform((s) => {
  const t = s.toLowerCase().trim();
  if ((DOMAIN_NODE_TYPES as readonly string[]).includes(t)) return t as DomainNodeType;
  if (/^(org|company|organisation|department|team)/.test(t)) return "organization";
  if (/^(people|human|contact)/.test(t)) return "person";
  return "thing";
});
const short = (n: number) => z.string().trim().min(1).max(n);

/** What the extraction model answers (validated; extra fields ignored). */
export const extractionSchema = z.object({
  entities: z.array(z.object({
    ref: short(40),
    label: short(120),
    /** The exact words in the text that name it (for highlighting). */
    surface: z.string().trim().max(160).optional(),
    type: nodeType,
    /** "Organization/Team" or "team (organization)" → "Team". */
    kind: z.string().trim().max(60).nullish().transform((k) => (k ? k.split("/").pop()!.replace(/\s*\([^)]*\)\s*$/, "").trim() || null : k)),
    existingNodeId: z.string().nullish(),
  })).max(40).default([]),
  facts: z.array(z.object({
    from: short(40),
    relation: short(60),
    to: short(40),
    quote: z.string().trim().max(300).optional(),
  })).max(60).default([]),
  attributes: z.array(z.object({
    ref: short(40),
    label: short(60),
    value: z.string().trim().max(300),
    dataType: z.enum(["text", "date", "number", "url", "email", "phone"]).default("text"),
  })).max(40).default([]),
  /** Kinds the text calls something by that may already exist under another name: [{ label, sameAs }]. */
  synonyms: z.array(z.object({ label: short(60), sameAs: short(60) })).max(20).default([]),
});
export type Extraction = z.infer<typeof extractionSchema>;

/** An existing node the extraction may refer to (found by the caller with a readable search). */
export type KnownNode = { id: string; label: string; aliases?: string[]; type: string; kind?: string | null };

export type PlannedKind = { nodeType: MetaNodeType; key: string; label: string; pluralLabel: string; isNew: boolean; reusedBecause?: string };
export type PlannedRelation = { key: string; label: string; inverseLabel: string; fromTypes: string[]; toTypes: string[]; isNew: boolean };
export type PlannedEntity = {
  ref: string; label: string; surface: string; type: MetaNodeType; kindKey: string | null; kindLabel: string | null;
  newKind: boolean; nodeId: string | null; existing: boolean;
  /** A person's "kind" that is really a role they hold (teacher, coach, landlord): proposed as a role edge, not a kind. */
  roleKey?: string | null; roleLabel?: string | null;
};
/** A role the plan uses; `isNew` when the graph doesn't know it yet (proposed with addRole). */
export type PlannedRole = { key: string; label: string; isNew: boolean };
export type PlannedFact = { ref: string; from: string; to: string; relationKey: string; relationLabel: string; newRelation: boolean; quote?: string };
export type PlannedAttribute = { ref: string; key: string; label: string; value: string; dataType: string; newAttribute: boolean };

export type DomainPlan = {
  kinds: PlannedKind[]; relations: PlannedRelation[]; entities: PlannedEntity[]; facts: PlannedFact[]; attributes: PlannedAttribute[];
  /** Roles people hold in this plan (optional so older callers keep working). */
  roles?: PlannedRole[];
};

export const YOU = "you";

function matchKnown(known: KnownNode[], label: string, type?: string, id?: string | null): KnownNode | undefined {
  if (id) {
    const byId = known.find((n) => n.id === id);
    if (byId) return byId;
  }
  const n = normalizeTerm(label);
  const same = known.filter((k) => normalizeTerm(k.label) === n || (k.aliases ?? []).some((a) => normalizeTerm(a) === n));
  return same.find((k) => !type || k.type === type) ?? same[0];
}

/** A key not used by the model yet (for the kind's node type, or any relation). */
function freeKey(base: string, taken: (k: string) => boolean): string {
  if (!taken(base)) return base;
  for (let i = 2; i < 50; i++) if (!taken(`${base}_${i}`)) return `${base}_${i}`;
  return `${base}_${Date.now().toString(36)}`;
}

/** Relation phrasing in snake_case → a readable inverse when the model gave none ("works on" → "worked on by"). */
export function guessInverse(label: string): string {
  const l = label.trim().toLowerCase();
  const known: Record<string, string> = {
    "works on": "worked on by", "member of": "has member", "belongs to": "has", "leads": "led by", "owns": "owned by",
    "manages": "managed by", "reports to": "manages", "uses": "used by", "sponsors": "sponsored by", "part of": "has part",
  };
  if (known[l]) return known[l];
  const m = /^(\w+?)s(\s.*)?$/.exec(l);
  if (m && !l.includes(" of")) return `${m[1]}ed${m[2] ? m[2].replace(/\s(on|in|at|for|with)$/, " $1") : ""} by`;
  return `${l} (reversed)`;
}

/**
 * Map an extraction onto the model. `known` = existing readable nodes that might be meant; `self` = the viewer's own
 * person node in this graph (the extraction calls it "you").
 */
export function planFromExtraction(m: Pick<MetaModel, "kinds" | "relations" | "attributes"> & Pick<Partial<MetaModel>, "roles">, x: Extraction, known: KnownNode[], self: { id: string | null; label: string }, opts: { text?: string } = {}): DomainPlan {
  const kinds: PlannedKind[] = [];
  const relations: PlannedRelation[] = [];
  const entities: PlannedEntity[] = [];
  const roles: PlannedRole[] = [];
  /**
   * People and roles are different things: a person's "kind" that names a role (a known role word, a role the graph
   * has, or any new word other than the person kinds that stay kinds) becomes a role they hold.
   */
  const roleFor = (word: string): PlannedRole | null => {
    const t = normalizeTerm(word);
    if (!t) return null;
    // Who someone is in this graph (a child of the family, a partner) stays their kind.
    if (KEPT_PERSON_KINDS.has(toKey(word)) || m.kinds.some((k) => k.nodeType === "person" && KEPT_PERSON_KINDS.has(k.key) && normalizeTerm(k.label) === t)) return null;
    const known = (m.roles ?? []).find((r) => normalizeTerm(r.key) === t || normalizeTerm(r.label) === t || (r.labelDa && normalizeTerm(r.labelDa) === t));
    const hit = detectRole(word);
    const key = known?.key ?? (hit && !hit.family ? hit.role : null);
    if (key) {
      const r = roles.find((x) => x.key === key) ?? { key, label: known?.label ?? titleCase(key.replace(/_/g, " ")), isNew: false };
      if (!roles.includes(r)) roles.push(r);
      return r;
    }
    if (hit?.family) return null;
    if (m.kinds.some((k) => k.nodeType === "person" && !k.hidden && (normalizeTerm(k.label) === t || k.key === toKey(word)))) return null; // a person kind the graph keeps
    const newKey = toKey(word);
    if (!newKey) return null;
    const prior = roles.find((x) => x.key === newKey);
    if (prior) return prior;
    const r: PlannedRole = { key: newKey, label: titleCase(word), isNew: true };
    roles.push(r);
    return r;
  };
  const synonymOf = new Map(x.synonyms.map((s) => [normalizeTerm(s.label), s.sameAs]));

  const kindFor = (type: MetaNodeType, label: string): PlannedKind => {
    const prior = kinds.find((k) => normalizeTerm(k.label) === normalizeTerm(label) || normalizeTerm(k.key) === normalizeTerm(label));
    if (prior) return prior;
    const hit = findSynonymKind(m, label, type) ?? (synonymOf.has(normalizeTerm(label)) ? findSynonymKind(m, synonymOf.get(normalizeTerm(label))!, type) : null);
    if (hit) {
      const k: PlannedKind = { nodeType: hit.kind.nodeType, key: hit.kind.key, label: hit.kind.label, pluralLabel: hit.kind.pluralLabel ?? pluralize(hit.kind.label), isNew: false, reusedBecause: hit.reason };
      kinds.push(k);
      return k;
    }
    const key = freeKey(toKey(label), (c) => m.kinds.some((k) => k.nodeType === type && k.key === c) || kinds.some((k) => k.nodeType === type && k.key === c));
    const k: PlannedKind = { nodeType: type, key, label: titleCase(label), pluralLabel: pluralize(titleCase(label)), isNew: true };
    kinds.push(k);
    return k;
  };

  const kindLabels = m.kinds.map((k) => k.label);
  for (const e0 of x.entities) {
    const surface = cleanSurface(e0.surface ?? "", e0.label);
    const named = opts.text ? kindWordNear(opts.text, surface || e0.label, kindLabels) : null;
    // The word the writer used wins over the model's guess ("department", not the existing "Team").
    const kindName = named && (!e0.kind || !sameTerm(named, e0.kind)) ? titleCase(normalizeTerm(named)) : e0.kind;
    const trimmed = trimKindWord(e0.label, surface, kindName);
    const e = { ...e0, label: trimmed.label, surface: trimmed.surface, kind: kindName };
    if (normalizeTerm(e.ref) === YOU || normalizeTerm(e.label) === YOU) continue;
    if (entities.some((p) => p.ref === e.ref)) continue;
    const hit = matchKnown(known, e.label, undefined, e.existingNodeId);
    if (hit) {
      const k = hit.kind ? m.kinds.find((x) => x.nodeType === hit.type && x.key === hit.kind) : undefined;
      entities.push({ ref: e.ref, label: hit.label, surface: e.surface || e.label, type: hit.type as MetaNodeType, kindKey: hit.kind ?? null, kindLabel: k?.label ?? null, newKind: false, nodeId: hit.id, existing: true });
      continue;
    }
    let type = e.type as MetaNodeType;
    let kind: PlannedKind | null = null;
    // A kind that only repeats the type ("Topic", "Person") says nothing; "Project" as a kind of project is kept
    // (proposed once, reused after) so projects can be told apart from other kinds of projects later.
    const bare = !!e.kind && normalizeTerm(e.kind) === normalizeTerm(type) && type !== "project";
    const role = type === "person" && e.kind && !bare ? roleFor(e.kind) : null;
    if (role) {
      entities.push({ ref: e.ref, label: e.label, surface: e.surface || e.label, type, kindKey: null, kindLabel: null, newKind: false, nodeId: null, existing: false, roleKey: role.key, roleLabel: role.label });
      continue;
    }
    if (e.kind && !bare) kind = kindFor(type, e.kind);
    if (kind && !kind.isNew) type = kind.nodeType; // reuse the type the existing kind lives on
    entities.push({ ref: e.ref, label: e.label, surface: e.surface || e.label, type, kindKey: kind?.key ?? null, kindLabel: kind?.label ?? null, newKind: !!kind?.isNew, nodeId: null, existing: false });
  }

  const typeOfRef = (ref: string): string => (normalizeTerm(ref) === YOU ? "person" : entities.find((e) => e.ref === ref)?.type ?? "thing");
  const refOk = (ref: string) => (normalizeTerm(ref) === YOU ? !!self.id : entities.some((e) => e.ref === ref));
  const facts: PlannedFact[] = [];
  for (const f of x.facts) {
    if (!refOk(f.from) || !refOk(f.to) || f.from === f.to) continue;
    let from = normalizeTerm(f.from) === YOU ? YOU : f.from;
    let to = normalizeTerm(f.to) === YOU ? YOU : f.to;
    let hit = findSynonymRelation(m, f.relation);
    // A relation meant for other kinds of things (supports: document → anything) isn't reused for a sponsor.
    if (hit) {
      const [ft, tt] = hit.direction === "out" ? [typeOfRef(from), typeOfRef(to)] : [typeOfRef(to), typeOfRef(from)];
      const fits = (types: string[], t: string) => !types.length || types.includes(t);
      if (!fits(hit.relation.fromTypes, ft) || !fits(hit.relation.toTypes, tt)) hit = null;
    }
    let rel: PlannedRelation;
    if (hit) {
      if (hit.direction === "in") [from, to] = [to, from];
      rel = relations.find((r) => r.key === hit.relation.key) ?? { key: hit.relation.key, label: hit.relation.label, inverseLabel: hit.relation.inverseLabel, fromTypes: hit.relation.fromTypes, toTypes: hit.relation.toTypes, isNew: false };
    } else {
      const label = f.relation.toLowerCase().replace(/_/g, " ").trim();
      const prior = relations.find((r) => r.isNew && normalizeTerm(r.label) === normalizeTerm(label));
      rel = prior ?? {
        key: freeKey(toKey(label), (c) => m.relations.some((r) => r.key === c) || relations.some((r) => r.key === c)),
        label, inverseLabel: guessInverse(label), fromTypes: [typeOfRef(from)], toTypes: [typeOfRef(to)], isNew: true,
      };
    }
    if (!relations.includes(rel) && !relations.some((r) => r.key === rel.key)) relations.push(rel);
    const key = `${from}|${rel.key}|${to}`;
    if (facts.some((x) => `${x.from}|${x.relationKey}|${x.to}` === key)) continue;
    facts.push({ ref: `f${facts.length + 1}`, from, to, relationKey: rel.key, relationLabel: rel.label, newRelation: rel.isNew, quote: f.quote });
  }

  // "my department Architecture Enablement", "our team X": the writer belongs to that organisation, even when the
  // model only said what the project belongs to.
  if (opts.text && self.id) {
    for (const e of entities.filter((e) => e.type === "organization")) {
      if (!isPossessive(opts.text, e.surface) && !isPossessive(opts.text, e.label)) continue;
      if (facts.some((f) => (f.from === YOU && f.to === e.ref) || (f.to === YOU && f.from === e.ref))) continue;
      const hit = findSynonymRelation(m, "member of");
      const rel: PlannedRelation = hit && hit.direction === "out"
        ? { key: hit.relation.key, label: hit.relation.label, inverseLabel: hit.relation.inverseLabel, fromTypes: hit.relation.fromTypes, toTypes: hit.relation.toTypes, isNew: false }
        : relations.find((r) => r.key === "member_of") ?? { key: "member_of", label: "member of", inverseLabel: "has member", fromTypes: ["person"], toTypes: ["organization"], isNew: true };
      if (!relations.some((r) => r.key === rel.key)) relations.push(rel);
      facts.push({ ref: `f${facts.length + 1}`, from: YOU, to: e.ref, relationKey: rel.key, relationLabel: rel.label, newRelation: rel.isNew, quote: e.surface });
    }
  }

  // "a project for my department X": the project belongs to X (when the text describes one project).
  if (opts.text) {
    const projects = entities.filter((e) => e.type === "project");
    if (projects.length === 1) {
      const p = projects[0];
      for (const o of entities.filter((e) => e.type === "organization")) {
        if (facts.some((f) => (f.from === p.ref && f.to === o.ref) || (f.from === o.ref && f.to === p.ref))) continue;
        if (!projectFor(opts.text, o.surface || o.label)) continue;
        const hit = findSynonymRelation(m, "belongs to");
        const rel: PlannedRelation = hit && hit.direction === "out"
          ? { key: hit.relation.key, label: hit.relation.label, inverseLabel: hit.relation.inverseLabel, fromTypes: hit.relation.fromTypes, toTypes: hit.relation.toTypes, isNew: false }
          : relations.find((r) => r.key === "belongs_to") ?? { key: "belongs_to", label: "belongs to", inverseLabel: "has", fromTypes: ["project"], toTypes: ["organization"], isNew: true };
        if (!relations.some((r) => r.key === rel.key)) relations.push(rel);
        facts.push({ ref: `f${facts.length + 1}`, from: p.ref, to: o.ref, relationKey: rel.key, relationLabel: rel.label, newRelation: rel.isNew, quote: o.surface });
      }
    }
  }

  const attributes: PlannedAttribute[] = [];
  for (const a of x.attributes) {
    const ent = entities.find((e) => e.ref === a.ref);
    if (!ent || !a.value) continue;
    const have = m.attributes.find((x) => x.nodeType === ent.type && (!x.kindKey || x.kindKey === ent.kindKey) && (normalizeTerm(x.label) === normalizeTerm(a.label) || x.key === toKey(a.label)));
    attributes.push({ ref: a.ref, key: have?.key ?? toKey(a.label), label: have?.label ?? titleCase(a.label), value: a.value, dataType: have?.dataType ?? a.dataType, newAttribute: !have });
  }

  return { kinds: kinds.filter((k) => k.isNew || entities.some((e) => e.kindKey === k.key)), relations, entities, facts, attributes, roles };
}

/** "my department X", "our team X", "min afdeling X": the text says the writer belongs to X. */
export function isPossessive(text: string, name: string): boolean {
  if (!name) return false;
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b(my|our|min|mit|vores)\\s+(?:[\\p{L}-]+\\s+){0,2}?${esc}`, "iu").test(text);
}

const SKIP = new Set(["the", "a", "an", "my", "our", "your", "his", "her", "their", "is", "was", "called", "named", "named:", "den", "det", "en", "et", "min", "mit", "vores", "hedder", "kaldet", "som"]);
const NOUNISH = /(ment|tion|sion|ship|ity|ness|ure|ance|ence|ery|ory|ics|ing|ning|ling)$/i;

/**
 * The kind the text itself gives a name: "my department Architecture Enablement" → department, "the project is called
 * EAM Platform" → project. Looks at up to three words before the name, skipping articles and "is called"; accepts only
 * words that look like kinds (known kind words, the model's own kinds, or noun endings).
 */
export function kindWordNear(text: string, surface: string, kindLabels: string[] = []): string | null {
  const i = text.toLowerCase().indexOf(surface.toLowerCase());
  if (i <= 0) return null;
  const words = text.slice(Math.max(0, i - 60), i).split(/[\s,;:()]+/).filter(Boolean).reverse();
  let seen = 0;
  for (const w0 of words) {
    const w = w0.toLowerCase().replace(/[^\p{L}-]/gu, "");
    if (!w) continue;
    if (SKIP.has(w)) continue;
    if (++seen > 2) break;
    if (isKnownKindWord(w) || kindLabels.some((k) => sameTerm(k, w) === "same") || (w.length > 5 && NOUNISH.test(w))) return w;
    return null;
  }
  return null;
}

/** "Data Mesh project" (kind Project) → "Data Mesh": a lowercase trailing kind word isn't part of the name. */
export function trimKindWord(label: string, surface: string, kind: string | null | undefined): { label: string; surface: string } {
  if (!kind) return { label, surface };
  const cut = (s: string) => {
    const m = /^(.*\S)\s+([a-zæøå]+)$/.exec(s);
    return m && sameTerm(m[2], kind) ? m[1] : s;
  };
  const l = cut(label), s = cut(surface);
  return l.length >= 2 ? { label: l, surface: s.length >= 2 ? s : surface } : { label, surface };
}

/** The surface without a leading "my department" when the label is inside it. */
export function cleanSurface(surface: string, label: string): string {
  if (!surface) return label;
  const at = surface.toLowerCase().indexOf(label.toLowerCase());
  return at > 0 ? surface.slice(at, at + label.length) : surface;
}

/** "a project for my department X", "projekt for X": the project is done for (belongs to) X. */
export function projectFor(text: string, org: string): boolean {
  if (!org) return false;
  const esc = org.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b(project|projekt|initiative|programme|program)\\s+(for|of|in|under|i|hos)\\s+(?:[\\p{L}-]+\\s+){0,3}?${esc}`, "iu").test(text);
}

/** One op of a change set, in the shape src/lib/changes expects (kept structural so this file stays pure). */
export type PlanOp = { op: string; note?: string; receipt?: Record<string, unknown> } & Record<string, unknown>;

/**
 * The plan as change-set ops: new kinds and relation types first, then new nodes (ids minted here so edges can point at
 * them), then facts. `receipt(quote)` builds the evidence for each op.
 */
export function opsFromPlan(plan: DomainPlan, opts: { selfId: string | null; mint: () => string; receipt: (quote: string | undefined) => Record<string, unknown> }): { ops: PlanOp[]; nodeIds: Record<string, string> } {
  const ops: PlanOp[] = [];
  const nodeIds: Record<string, string> = {};
  if (opts.selfId) nodeIds[YOU] = opts.selfId;
  for (const k of plan.kinds.filter((k) => k.isNew && plan.entities.some((e) => e.kindKey === k.key && e.newKind))) {
    const example = plan.entities.find((e) => e.kindKey === k.key);
    ops.push({ op: "addKind", nodeType: k.nodeType, key: k.key, label: k.label, pluralLabel: k.pluralLabel, note: `New kind for ${example?.label ?? k.label}`, receipt: opts.receipt(example?.surface) });
  }
  for (const r of plan.relations.filter((r) => r.isNew && plan.facts.some((f) => f.relationKey === r.key))) {
    const f = plan.facts.find((f) => f.relationKey === r.key);
    ops.push({ op: "addRelationType", key: r.key, label: r.label, inverseLabel: r.inverseLabel, fromTypes: r.fromTypes, toTypes: r.toTypes, category: "other", note: `New relation “${r.label}”`, receipt: opts.receipt(f?.quote) });
  }
  for (const r of (plan.roles ?? []).filter((r) => r.isNew && plan.entities.some((e) => e.roleKey === r.key))) {
    const example = plan.entities.find((e) => e.roleKey === r.key);
    ops.push({ op: "addRole", key: r.key, label: r.label, pluralLabel: pluralize(r.label), circle: "other", note: `New role for ${example?.label ?? r.label}`, receipt: opts.receipt(example?.surface) });
  }
  for (const a of plan.attributes.filter((a) => a.newAttribute)) {
    const e = plan.entities.find((e) => e.ref === a.ref);
    if (!e || ops.some((o) => o.op === "addAttribute" && o.key === a.key && o.nodeType === e.type)) continue;
    ops.push({ op: "addAttribute", nodeType: e.type, kindKey: e.kindKey, key: a.key, label: a.label, type: a.dataType, note: `New detail “${a.label}”`, receipt: opts.receipt(`${a.label}: ${a.value}`) });
  }
  for (const e of plan.entities) {
    if (e.nodeId) { nodeIds[e.ref] = e.nodeId; continue; }
    const id = opts.mint();
    nodeIds[e.ref] = id;
    const props = Object.fromEntries(plan.attributes.filter((a) => a.ref === e.ref).map((a) => [a.key, a.value]));
    ops.push({ op: "addNode", nodeId: id, type: e.type, kind: e.kindKey, label: e.label, ...(Object.keys(props).length ? { props } : {}), note: e.kindLabel ? `New ${e.kindLabel}` : "New", receipt: opts.receipt(e.surface) });
  }
  for (const e of plan.entities.filter((e) => e.nodeId)) {
    const props = Object.fromEntries(plan.attributes.filter((a) => a.ref === e.ref).map((a) => [a.key, a.value]));
    if (Object.keys(props).length) ops.push({ op: "updateNode", nodeId: e.nodeId!, set: { props }, note: `Details for ${e.label}`, receipt: opts.receipt(e.surface) });
  }
  for (const f of plan.facts) {
    const fromId = nodeIds[f.from], toId = nodeIds[f.to];
    if (!fromId || !toId) continue;
    ops.push({ op: "addEdge", fromId, toId, relation: f.relationKey, status: "confirmed", note: f.relationLabel, receipt: opts.receipt(f.quote) });
  }
  // Roles held: in the organisation, place or project the plan connects them to, else with no known context.
  for (const e of plan.entities.filter((e) => e.roleKey)) {
    const fromId = nodeIds[e.ref];
    if (!fromId) continue;
    const ctx = plan.facts.map((f) => (f.from === e.ref ? f.to : null)).find((ref) => ref && ["organization", "place", "project"].includes(plan.entities.find((x) => x.ref === ref)?.type ?? ""));
    const toId = (ctx && nodeIds[ctx]) || fromId;
    ops.push({ op: "addEdge", fromId, toId, relation: roleRelation(e.roleKey!), status: "confirmed", note: e.roleLabel ?? e.roleKey!, receipt: opts.receipt(e.surface) });
  }
  return { ops, nodeIds };
}

/** Counts for the "Will add" strip: things (new nodes), facts and new kinds/relations. */
export function planSummary(plan: DomainPlan): { things: number; facts: number; newKinds: number; newRelations: number; links: number } {
  return {
    things: plan.entities.filter((e) => !e.existing).length,
    facts: plan.facts.length,
    newKinds: plan.kinds.filter((k) => k.isNew && plan.entities.some((e) => e.kindKey === k.key && e.newKind)).length,
    newRelations: plan.relations.filter((r) => r.isNew).length,
    links: plan.entities.filter((e) => e.existing).length,
  };
}
