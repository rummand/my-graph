/**
 * Pure meta-model logic (no DB, safe for client components): merging built-ins with household rows, lookups,
 * prop validation and kind suggestion.
 *
 * Hiding a built-in: the household stores a *tombstone* — a household row with the built-in's key and
 * `builtin = true` (household rows are otherwise never builtin). The schema has no `hidden` column yet; see
 * `isTombstone`. Deleting the household row restores the built-in.
 */
import { z } from "zod";
import type {
  AttrType, EmergentFields, MetaAttribute, MetaKind, MetaModel, MetaNodeType, MetaOrigin, MetaRelation, MetaRole, PropError, ValidateResult,
} from "./types";
import { KEPT_PERSON_KINDS, findRole, roleCategory, roleKeyOf, roleWords } from "./roles";

type Row = { householdId: string | null; builtin: boolean } & EmergentFields;

type MergedKeys = "origin" | "hidden" | "householdRowId" | "offTemplate";
export type KindRow = Omit<MetaKind, MergedKeys>;
export type RelationRow = Omit<MetaRelation, MergedKeys>;
export type AttributeRow = Omit<MetaAttribute, MergedKeys>;
export type RoleRow = Omit<MetaRole, MergedKeys>;

/** A household row that hides the built-in with the same key. */
export function isTombstone(r: { householdId: string | null; builtin: boolean }): boolean {
  return r.householdId !== null && r.builtin;
}

/**
 * How one graph reads the household's rows (see src/lib/templates): which graph it is, and which built-ins its
 * template uses. Built-ins the template doesn't use are flagged hidden + offTemplate (they still label old data).
 */
export type GraphLens = {
  graphId?: string | null;
  keepBuiltin?: (table: "kinds" | "relations" | "attributes" | "roles", row: { key: string; nodeType?: string; kindKey?: string | null; category?: string; circle?: string | null }) => boolean;
  /** Household rows shared between graphs (template rows with graphId null): does this graph show them? */
  keepShared?: (table: "kinds" | "relations" | "attributes" | "roles", row: { key: string; nodeType?: string; kindKey?: string | null }) => boolean;
  /** Template circle for a kind (a colleague is "team" in a Work graph). */
  circleOf?: (kind: { nodeType: string; key: string; circle: string | null }) => string | null | undefined;
  /** Template circle for a role (a colleague is "team" in a Work graph). */
  roleCircleOf?: (role: { key: string; circle: string | null }) => string | null | undefined;
};

/** Does a household row belong to the graph being read? Household-wide rows (graphId null) belong to every graph. */
export function inGraph(r: { graphId?: string | null }, graphId: string | null | undefined): boolean {
  return !r.graphId || (!!graphId && r.graphId === graphId);
}

type MergeMeta = { origin: MetaOrigin; hidden: boolean; householdRowId: string | null; offTemplate?: boolean };

function mergeRows<R extends Row & { id: string }, O>(rows: R[], keyOf: (r: R) => string, householdId: string | null,
  wrap: (r: R, m: MergeMeta) => O, lens: GraphLens = {}, keep: (r: R) => boolean = () => true, keepShared: (r: R) => boolean = () => true): { active: O[]; candidates: O[] } {
  const builtins = new Map<string, R>();
  const own = new Map<string, R>();
  const candidates: O[] = [];
  for (const r of rows) {
    if (r.householdId === null) builtins.set(keyOf(r), r);
    else if (r.householdId === householdId && inGraph(r, lens.graphId)) {
      if (!r.graphId && r.source === "template" && !keepShared(r)) continue;
      if (r.status === "candidate" && !isTombstone(r)) candidates.push(wrap(r, { origin: "household", hidden: false, householdRowId: r.id }));
      else own.set(keyOf(r), r);
    }
  }
  const out: O[] = [];
  for (const [k, b] of builtins) {
    const o = own.get(k);
    const off = !keep(b);
    if (!o) out.push(wrap(b, { origin: "builtin", hidden: off, householdRowId: null, offTemplate: off || undefined }));
    else if (isTombstone(o)) out.push(wrap(b, { origin: "builtin", hidden: true, householdRowId: o.id }));
    else out.push(wrap(o, { origin: "override", hidden: o.status === "hidden", householdRowId: o.id }));
  }
  for (const [k, o] of own) {
    if (builtins.has(k) || isTombstone(o)) continue; // tombstone for a built-in that no longer exists: ignore
    out.push(wrap(o, { origin: "household", hidden: o.status === "hidden", householdRowId: o.id }));
  }
  return { active: out, candidates };
}

export const kindId = (r: { nodeType: string; key: string }) => `${r.nodeType}:${r.key}`;
export const attributeId = (r: { nodeType: string; kindKey: string | null; key: string }) => `${r.nodeType}:${r.kindKey ?? "*"}:${r.key}`;

const emergent = (r: Row, m: MergeMeta) => ({
  status: (r.status ?? "active") as MetaKind["status"], source: (r.source ?? (r.householdId === null ? "builtin" : "manual")) as MetaKind["source"],
  graphId: r.graphId ?? null, evidenceCount: r.evidenceCount ?? 0, firstSeenAt: r.firstSeenAt ?? null, changeSetId: r.changeSetId ?? null,
  createdAt: r.createdAt ?? null, ...m,
});

/**
 * Merge built-ins (householdId null) with one household's rows, as seen from one graph (`lens`). A household row with
 * the same key wins; a tombstone marks the built-in hidden (it stays in the result, flagged, so it can be restored and
 * old data still labels). Household rows for another graph are left out; candidates come back separately.
 */
export function mergeMetaModel(householdId: string | null, rows: { kinds: KindRow[]; relations: RelationRow[]; attributes: AttributeRow[]; roles?: RoleRow[] }, lens: GraphLens = {}): MetaModel {
  const keep = lens.keepBuiltin ?? (() => true);
  const shared = lens.keepShared ?? (() => true);
  const roleKeys = new Set((rows.roles ?? []).filter((r) => r.householdId === null).map((r) => r.key));
  const k = mergeRows(rows.kinds, kindId, householdId, (r, m): MetaKind => {
    const circle = lens.circleOf?.(r) ?? r.circle;
    // A built-in person kind that names a role (doctor, teacher, colleague …) is read as that role now: it still
    // labels people who have it until the conversion is delivered, but is never offered as a kind again.
    if (r.nodeType === "person" && m.origin === "builtin" && roleKeys.has(r.key) && !KEPT_PERSON_KINDS.has(r.key)) {
      return { ...r, circle, builtin: true, ...emergent(r, { ...m, hidden: true, offTemplate: true }) };
    }
    return { ...r, circle, builtin: m.origin !== "household", ...emergent(r, m) };
  }, lens, (r) => keep("kinds", r), (r) => shared("kinds", r));
  const ro = mergeRows(rows.roles ?? [], (r) => r.key, householdId, (r, m): MetaRole => {
    const circle = lens.roleCircleOf?.(r) ?? r.circle;
    return { ...r, circle, builtin: m.origin !== "household", ...emergent(r, m) };
  }, lens, (r) => keep("roles", r), (r) => shared("roles", r));
  const rel = mergeRows(rows.relations, (r) => r.key, householdId, (r, m): MetaRelation => ({ ...r, builtin: m.origin !== "household", ...emergent(r, m) }),
    lens, (r) => keep("relations", r), (r) => shared("relations", r));
  const a = mergeRows(rows.attributes, attributeId, householdId, (r, m): MetaAttribute => ({ ...r, builtin: m.origin !== "household", ...emergent(r, m) }),
    lens, (r) => keep("attributes", r), (r) => shared("attributes", r));
  const byKind = (x: MetaKind, y: MetaKind) => x.nodeType.localeCompare(y.nodeType) || x.sortOrder - y.sortOrder || x.label.localeCompare(y.label);
  const kinds = k.active.sort(byKind);
  const attributes = a.active.sort((x, y) => x.sortOrder - y.sortOrder);
  const byRole = (x: MetaRole, y: MetaRole) => x.sortOrder - y.sortOrder || x.label.localeCompare(y.label);
  return {
    kinds, relations: rel.active, attributes, roles: ro.active.sort(byRole), graphId: lens.graphId ?? null,
    candidates: { kinds: k.candidates.sort(byKind), relations: rel.candidates, attributes: a.candidates, roles: ro.candidates.sort(byRole) },
  };
}

/* ── Lookups ──────────────────────────────────────────────────────────────────────────────────────────── */

/** Visible kinds of a node type, in display order. */
export function kindsFor(m: MetaModel, type: MetaNodeType | string): MetaKind[] {
  return m.kinds.filter((k) => k.nodeType === type && !k.hidden);
}

/** A kind by key (hidden ones too, so existing nodes still label). */
export function findKind(m: MetaModel, type: string, key: string | null | undefined): MetaKind | undefined {
  if (!key) return undefined;
  return m.kinds.find((k) => k.nodeType === type && k.key === key);
}

export function findRelation(m: MetaModel, key: string): MetaRelation | undefined {
  const found = m.relations.find((r) => r.key === key);
  if (found) return found;
  const roleKey = roleKeyOf(key);
  return roleKey ? roleAsRelation(findRole(m, roleKey), roleKey) : undefined;
}

/**
 * A role read as the relation of its edges ("role:doctor": "doctor at" / "has as doctor"), so every place that labels
 * a fact reads a role held without knowing about roles. English words; the people pages word roles per language.
 */
export function roleAsRelation(r: MetaRole | undefined, key: string): MetaRelation {
  const w = roleWords(r, "en", key);
  return {
    id: r?.id ?? `role:${key}`, householdId: r?.householdId ?? null, key: `role:${key}`, label: `${w.label.toLowerCase()} ${w.preposition}`,
    inverseLabel: `has as ${w.inverse}`, category: roleCategory(r), fromTypes: ["person"], toTypes: r?.contextTypes ?? [], symmetric: false,
    builtin: r?.builtin ?? false, origin: r?.origin ?? "builtin", hidden: r?.hidden ?? false, householdRowId: r?.householdRowId ?? null,
    status: r?.status, source: r?.source, graphId: r?.graphId ?? null,
  };
}

/**
 * Human label for an edge relation read in a direction: "out" = from → to ("parent of"), "in" = to ← from ("child of").
 * Unknown keys fall back to the key with underscores as spaces.
 */
export function relationLabel(m: MetaModel, key: string, direction: "out" | "in" = "out"): string {
  const r = findRelation(m, key);
  if (!r) return key.replace(/_/g, " ");
  return direction === "out" || r.symmetric ? r.label : r.inverseLabel;
}

/** Relations that may start at `fromType` and end at `toType` (empty type lists mean "any"). Hidden ones excluded. */
export function relationsBetween(m: MetaModel, fromType: string, toType?: string): MetaRelation[] {
  return m.relations.filter((r) => !r.hidden
    && (r.fromTypes.length === 0 || r.fromTypes.includes(fromType))
    && (!toType || r.toTypes.length === 0 || r.toTypes.includes(toType)));
}

/** The kind and its ancestors via parentKey (nearest first), guarded against cycles. */
function kindChain(m: MetaModel, type: string, kind: string | null | undefined): string[] {
  const chain: string[] = [];
  let k = findKind(m, type, kind);
  if (!k && kind) chain.push(kind);
  while (k && !chain.includes(k.key) && chain.length < 8) {
    chain.push(k.key);
    k = k.parentKey ? findKind(m, type, k.parentKey) : undefined;
  }
  return chain;
}

/**
 * Attributes a node of this type and kind carries: type-wide ones first, then kind-specific (including inherited via
 * parentKey). A kind-specific attribute replaces a type-wide one with the same key. Hidden attributes excluded.
 */
export function attributesFor(m: MetaModel, type: string, kind?: string | null, roles: string[] = []): MetaAttribute[] {
  // Details a role carries (a doctor's clinic, a teacher's subject) are attributes keyed by the role, as they were by the kind.
  const chain = [...kindChain(m, type, kind), ...roles.filter((r) => r !== kind)];
  const byKey = new Map<string, MetaAttribute>();
  const visible = m.attributes.filter((a) => a.nodeType === type && !a.hidden);
  for (const a of visible.filter((a) => a.kindKey === null)) byKey.set(a.key, a);
  // farthest ancestor first so the nearest kind wins
  for (const k of [...chain].reverse()) for (const a of visible.filter((a) => a.kindKey === k)) {
    byKey.delete(a.key);
    byKey.set(a.key, a);
  }
  return [...byKey.values()];
}

/* ── Validation ───────────────────────────────────────────────────────────────────────────────────────── */

const DATE_RE = /^(\d{4}-\d{2}-\d{2}|--\d{2}-\d{2})$/;
const PHONE_RE = /^\+?[0-9][0-9 ()./-]{4,22}$/;

function validDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const [y, mo, d] = s.startsWith("--") ? [2000, +s.slice(2, 4), +s.slice(5, 7)] : [+s.slice(0, 4), +s.slice(5, 7), +s.slice(8, 10)];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** zod schema for one attribute's (non-empty) value. */
export function attributeSchema(a: Pick<MetaAttribute, "dataType" | "options">): z.ZodType {
  const t: AttrType = a.dataType;
  switch (t) {
    case "text": return z.string().trim().max(500);
    case "longtext": return z.string().trim().max(10000);
    case "date": return z.string().trim().refine(validDate, "Use a date like 2018-05-14 (or --05-14 if you don't know the year)");
    case "number": return z.union([z.number(), z.string().trim().regex(/^-?\d+([.,]\d+)?$/).transform((s) => Number(s.replace(",", ".")))]).pipe(z.number().finite());
    case "boolean": return z.union([z.boolean(), z.enum(["true", "false"]).transform((s) => s === "true")]);
    case "enum": return z.string().refine((s) => a.options.includes(s), `Choose one of: ${a.options.join(", ")}`);
    case "email": return z.string().trim().pipe(z.email("That doesn't look like an email address"));
    case "phone": return z.string().trim().regex(PHONE_RE, "Use digits, spaces and an optional + (e.g. +45 12 34 56 78)");
    case "url": return z.string().trim().pipe(z.url("That doesn't look like a web address"));
  }
}

const isEmpty = (v: unknown) => v === undefined || v === null || (typeof v === "string" && v.trim() === "");

/**
 * Validate props for a node of `type`/`kind` against the meta model. Known attributes are checked and normalised;
 * unknown keys pass through untouched (extraction may store extra facts). Empty values become `null` (= remove).
 * `partial` skips the required check for keys not present (PATCH semantics).
 */
export function validateProps(m: MetaModel, type: string, kind: string | null | undefined, props: Record<string, unknown>,
  opts: { partial?: boolean } = {}): ValidateResult {
  const attrs = attributesFor(m, type, kind);
  const errors: PropError[] = [];
  const value: Record<string, unknown> = { ...props };
  for (const a of attrs) {
    const present = Object.prototype.hasOwnProperty.call(props, a.key);
    const v = props[a.key];
    if (isEmpty(v)) {
      if (a.required && (present || !opts.partial)) errors.push({ key: a.key, label: a.label, code: "required", message: `${a.label} is required` });
      if (present) value[a.key] = null;
      continue;
    }
    const r = attributeSchema(a).safeParse(v);
    if (r.success) { value[a.key] = r.data; continue; }
    const issue = r.error.issues[0];
    const code: PropError["code"] = issue?.code === "too_big" ? "too_long" : issue?.code === "invalid_type" ? "invalid_type" : "invalid_value";
    const message = code === "too_long" ? `${a.label} is too long` : code === "invalid_type" ? `${a.label} has the wrong type` : `${a.label}: ${issue?.message ?? "invalid value"}`;
    errors.push({ key: a.key, label: a.label, code, message });
  }
  return errors.length ? { ok: false, errors } : { ok: true, value };
}

/* ── Kind suggestion ──────────────────────────────────────────────────────────────────────────────────── */

type Rule = { type: MetaNodeType; kind: string; re: RegExp };

// English + Danish cues. Order matters: more specific first (tandlæge before læge, svigermor before mor).
const RULES: Rule[] = [
  { type: "person", kind: "dentist", re: /\b(tandlæge|dentist|tandplejer|børnetandpleje)/i },
  { type: "person", kind: "health_visitor", re: /\b(sundhedsplejerske|health visitor|skolesundhedsplejerske)/i },
  { type: "person", kind: "psychologist", re: /\b(psykolog|psychologist|ppr\b|therapist|terapeut)/i },
  { type: "person", kind: "doctor", re: /(^|\s)(dr\.|læge|doctor|gp\b|egen læge|speciallæge|paediatrician|pediatrician|børnelæge)/i },
  { type: "person", kind: "school_leader", re: /\b(skoleleder|afdelingsleder|principal|head ?teacher|daycare manager|institutionsleder)/i },
  { type: "person", kind: "pedagogue", re: /\b(pædagog|paedagog|pedagogue|sfo-?pædagog)/i },
  { type: "person", kind: "teacher", re: /\b(lærer|laerer|teacher|klasselærer|kontaktlærer|tutor)\b/i },
  { type: "person", kind: "babysitter", re: /\b(babysitter|barnepige|sitter|au ?pair)/i },
  { type: "person", kind: "in_law", re: /\b(svigermor|svigerfar|svigerforældre|svoger|svigerinde|in-?law)/i },
  { type: "person", kind: "grandparent", re: /\b(mormor|morfar|farmor|farfar|oldemor|oldefar|bedste(mor|far)|grand(ma|pa|mother|father|parent))/i },
  { type: "person", kind: "aunt_uncle", re: /\b(moster|faster|morbror|farbror|onkel|tante|aunt|uncle)\b/i },
  { type: "person", kind: "cousin", re: /\b(fætter|kusine|cousin)\b/i },
  { type: "person", kind: "classmate", re: /\b(klassekammerat|classmate)/i },
  { type: "person", kind: "neighbour", re: /\b(nabo|naboen|neighbou?r)/i },
  { type: "person", kind: "manager", re: /\b(chef|manager|boss)\b/i },
  { type: "person", kind: "colleague", re: /\b(kollega|colleague|co-?worker)/i },
  { type: "person", kind: "close_friend", re: /\b(best friend|bedste ven(inde)?|close friend)/i },
  { type: "person", kind: "friend", re: /\b(ven|veninde|friend)\b/i },
  { type: "person", kind: "partner", re: /\b(wife|husband|partner|hustru|kone|ægtemand|kæreste|spouse)\b/i },
  { type: "person", kind: "sibling", re: /\b(brother|sister|bror|søster|lillebror|storebror|lillesøster|storesøster|sibling)\b/i },

  { type: "place", kind: "daycare", re: /\b(børnehave|vuggestue|dagpleje|sfo|fritidshjem|fritidsklub|kindergarten|nursery|daycare|institution)/i },
  { type: "place", kind: "school", re: /\b(skole|school|gymnasium|efterskole)\b|skole\b/i },
  { type: "place", kind: "clinic", re: /\b(klinik|clinic|lægehus|hospital|sygehus|tandklinik|sundhedshus|praksis)/i },
  { type: "place", kind: "sports_club", re: /\b(klub|club|fc|bk|boldklub|svømmeklub|gymnastik|forening|spejder)\b/i },
  { type: "place", kind: "holiday_place", re: /\b(sommerhus|summer house|cabin|campsite|camping|hytte)/i },

  { type: "event", kind: "appointment", re: /\b(appointment|tid hos|konsultation|undersøgelse|vaccination|check-?up|kontrol)/i },
  { type: "event", kind: "school_event", re: /\b(forældremøde|skole-hjem|parent(s)?[- ]teacher|motionsdag|lejrskole|school (trip|event|meeting))/i },
  { type: "event", kind: "birthday", re: /\b(fødselsdag|birthday|bday)/i },
  { type: "event", kind: "trip", re: /\b(trip|tur|rejse|ferie|holiday|vacation|udflugt)\b/i },
  { type: "event", kind: "activity", re: /\b(træning|practice|training|kamp|match|lesson|undervisning|stævne)/i },
  { type: "event", kind: "milestone", re: /\b(first (day|step|word|tooth)|første (skoledag|skridt|ord|tand)|milestone|lært at)/i },
  { type: "event", kind: "decision", re: /\b(decided|decision|besluttede|beslutning|aftalt)/i },
  { type: "event", kind: "purchase", re: /\b(bought|purchase|købte|købt|ordered|bestilt)/i },

  { type: "topic", kind: "health", re: /\b(health|helbred|sygdom|allerg|medicin|sundhed)/i },
  { type: "topic", kind: "finances", re: /\b(budget|money|penge|økonomi|finance|skat|tax|loan|lån)/i },
  { type: "topic", kind: "legal", re: /\b(legal|contract|kontrakt|testamente|forsikring|insurance)/i },
  { type: "topic", kind: "school", re: /\b(skole|school|homework|lektier|aula)/i },
  { type: "topic", kind: "activities", re: /\b(sport|hobby|fritid|activities|aktiviteter)/i },
  { type: "topic", kind: "household", re: /\b(house|hus|bolig|repair|reparation|cleaning|rengøring)/i },
];

/** Relation → the kind the *other* end most likely is (e.g. someone who is `teacher_of` a child is a teacher). */
const RELATION_HINTS: Record<string, string> = {
  teacher_of: "teacher", treated_by: "doctor", partner_of: "partner", sibling_of: "sibling", grandparent_of: "grandparent",
  friend_of: "friend", neighbour_of: "neighbour", works_with: "colleague", colleague_of: "colleague",
};

export type KindSuggestion = { type: MetaNodeType; kind: string; confidence: number; reason: string };

/**
 * Heuristic kind for a new node: keywords (English and Danish) in the label first, then surrounding text, then the
 * relations it was found in. Returns null when nothing matches. Pass `m` to only suggest kinds that exist and are visible.
 */
export function suggestKind(label: string, context: { type?: MetaNodeType; text?: string; relations?: string[] } = {}, m?: MetaModel): KindSuggestion | null {
  const ok = (type: string, kind: string) => !m || kindsFor(m, type).some((k) => k.key === kind);
  const rules = RULES.filter((r) => !context.type || r.type === context.type);
  for (const r of rules) if (r.re.test(label) && ok(r.type, r.kind)) return { type: r.type, kind: r.kind, confidence: 0.8, reason: `"${label}" looks like a ${r.kind.replace(/_/g, " ")}` };
  if (context.text) for (const r of rules) if (r.re.test(context.text) && ok(r.type, r.kind)) return { type: r.type, kind: r.kind, confidence: 0.5, reason: `mentioned as ${r.kind.replace(/_/g, " ")} nearby` };
  if ((!context.type || context.type === "person") && context.relations) {
    for (const rel of context.relations) {
      const kind = RELATION_HINTS[rel];
      if (kind && ok("person", kind)) return { type: "person", kind, confidence: 0.4, reason: `linked by "${rel.replace(/_/g, " ")}"` };
    }
  }
  return null;
}
