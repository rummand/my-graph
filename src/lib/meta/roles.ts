/**
 * Roles (pure, safe for client components). People and roles are different things: Lars is a person; "doctor at
 * Lægehuset Vejle (since 2021)" is a role he holds. A person can hold several roles, each in a context and for a time.
 *
 * How a role held is stored: an edge `person —role:<key>→ context` (relation "role:doctor"). Each role is its own
 * relation type, derived from the role row instead of a meta_relations row, so the edge machinery works unchanged:
 * one fact per (person, role, context) with status, confidence, provenance, valid_from/valid_to and field-by-field
 * history; a change set proposes it with addEdge and delivering dedupes it like any fact. A role with no known context
 * points back at the person (the one self-edge the graph allows). Family roles that are real relations (parent_of,
 * partner_of …) stay relations: `impliedBy` reads them as roles, they are never stored twice.
 */
import type { MetaModel, MetaRole } from "./types";

export const ROLE_PREFIX = "role:";
export const roleRelation = (key: string) => `${ROLE_PREFIX}${key}`;
export const isRoleRelation = (relation: string | null | undefined): boolean => !!relation && relation.startsWith(ROLE_PREFIX);
export const roleKeyOf = (relation: string | null | undefined): string | null => (relation && relation.startsWith(ROLE_PREFIX) ? relation.slice(ROLE_PREFIX.length) || null : null);

/**
 * Person kinds that stay kinds: who someone is in this graph rather than a position they hold. A child of the family
 * carries the household's child details (school, sizes) and Aula/Famly hook onto it; a partner is half of the
 * household. Every other built-in person kind that names a role is read as that role.
 */
export const KEPT_PERSON_KINDS = new Set(["child", "partner", "other"]);

/** Practice graphs keep "client" and "patient" as the record kind (clinical access is decided on it); the role is added beside it. */
export const CLINICAL_RECORD_KINDS = new Set(["client", "patient"]);

/** The role a person kind becomes, or null when the kind stays a kind. */
export function roleKeyForKind(kind: string | null | undefined, roleKeys: ReadonlySet<string>): string | null {
  if (!kind || KEPT_PERSON_KINDS.has(kind) || CLINICAL_RECORD_KINDS.has(kind)) return null;
  return roleKeys.has(kind) ? kind : null;
}

/* ── Lookups and wording ────────────────────────────────────────────────────────────────────────────── */

export function rolesOf(m: MetaModel): MetaRole[] {
  return m.roles ?? [];
}

/** Visible roles (for pickers), in display order. */
export function visibleRoles(m: MetaModel): MetaRole[] {
  return rolesOf(m).filter((r) => !r.hidden);
}

/** A role by key, hidden ones too (old facts still read). */
export function findRole(m: MetaModel, key: string | null | undefined): MetaRole | undefined {
  if (!key) return undefined;
  return rolesOf(m).find((r) => r.key === key) ?? m.candidates?.roles?.find((r) => r.key === key);
}

export type RoleWording = { label: string; plural: string; preposition: string; inverse: string };

type Wordable = Pick<MetaRole, "key" | "label" | "pluralLabel" | "preposition" | "inverseLabel" | "labelDa" | "pluralLabelDa" | "prepositionDa" | "inverseLabelDa">;

/** The role's words in a language (Danish falls back to English where a household role has no Danish words yet). */
export function roleWords(r: Wordable | undefined, locale: string, key?: string): RoleWording {
  if (!r) {
    const label = (key ?? "role").replace(/_/g, " ");
    const cap = label.charAt(0).toUpperCase() + label.slice(1);
    return { label: cap, plural: cap, preposition: locale === "da" ? "for" : "of", inverse: label };
  }
  if (locale === "da" && r.labelDa) {
    return { label: r.labelDa, plural: r.pluralLabelDa ?? r.labelDa, preposition: r.prepositionDa ?? "for", inverse: (r.inverseLabelDa ?? r.labelDa).toLowerCase() };
  }
  return { label: r.label, plural: r.pluralLabel ?? r.label, preposition: r.preposition || "of", inverse: (r.inverseLabel ?? r.label).toLowerCase() };
}

const PLACE_WORDS = new Set(["at", "in", "på", "i", "hos"]);

/** The word between a role and its context: a person context always reads "of" / "for" ("Doctor of Emma", "Læge for Emma"). */
export function prepositionFor(words: RoleWording, contextType: string | null | undefined, locale: string): string {
  if (contextType === "person" && PLACE_WORDS.has(words.preposition)) return locale === "da" ? "for" : "of";
  return words.preposition;
}

/** "Doctor at Lægehuset Vejle", "Class teacher of 3.B", "Doctor" (no context). Time is added by the caller in its language. */
export function roleText(r: Wordable | undefined, key: string, context: { label: string; type: string } | null, locale: string): string {
  const w = roleWords(r, locale, key);
  if (!context) return w.label;
  return `${w.label} ${prepositionFor(w, context.type, locale)} ${context.label}`;
}

/** A relation edge read as a role: "role:doctor" → the doctor role; a family relation through `impliedBy`. */
export function relationAsRole(m: MetaModel, relation: string): { role: MetaRole | undefined; key: string } | null {
  const key = roleKeyOf(relation);
  return key ? { role: findRole(m, key), key } : null;
}

/** Category a role's edges are grouped under on a person's page (the circle it implies, in relation-category words). */
export function roleCategory(r: Pick<MetaRole, "circle"> | undefined): string {
  const c = r?.circle ?? "other";
  if (c === "family" || c === "us") return "family";
  if (c === "close" || c === "social" || c === "friends") return "social";
  if (c === "school") return "school";
  if (c === "care" || c === "clients" || c === "patients" || c === "practice") return "care";
  if (c === "work" || c === "team" || c === "manager" || c === "partners" || c === "network" || c === "stakeholders" || c === "suppliers") return "work";
  return "other";
}

/* ── Roles a person holds ───────────────────────────────────────────────────────────────────────────── */

export type RoleEdge = { id: string; fromId: string; toId: string; relation: string; status: string; validFrom?: Date | string | null; validTo?: Date | string | null };
export type RoleNode = { id: string; label: string; type: string };

export type HeldRole = {
  key: string;
  /** The fact it rests on: a role edge, or the relation that implies it. */
  edgeId: string;
  implied: boolean;
  context: RoleNode | null;
  from: string | null;
  to: string | null;
  /** Not ended (no end date, or one in the future). */
  current: boolean;
  status: string;
};

const DEAD = new Set(["rejected", "superseded"]);
const isoOf = (d: Date | string | null | undefined): string | null => (d ? new Date(d).toISOString() : null);

/**
 * The roles a person holds, from their role edges and the relations that imply roles, newest first and current ones
 * before past ones. Edges must already be filtered to what the viewer may read; ends the viewer can't see are dropped.
 */
export function rolesHeld(m: MetaModel, personId: string, edges: RoleEdge[], nodes: ReadonlyMap<string, RoleNode>, now = new Date()): HeldRole[] {
  const out: HeldRole[] = [];
  const seen = new Set<string>();
  const implied = rolesOf(m).filter((r) => r.impliedBy && !r.hidden);
  const push = (h: HeldRole) => {
    const k = `${h.key}|${h.context?.id ?? ""}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(h);
  };
  for (const e of edges) {
    if (DEAD.has(e.status)) continue;
    const key = roleKeyOf(e.relation);
    if (key && e.fromId === personId) {
      const ctx = e.toId === personId ? null : nodes.get(e.toId) ?? undefined;
      if (ctx === undefined) continue;
      const to = isoOf(e.validTo);
      push({ key, edgeId: e.id, implied: false, context: ctx, from: isoOf(e.validFrom), to, current: !to || new Date(to) > now, status: e.status });
      continue;
    }
    for (const r of implied) {
      const [rel, dir] = String(r.impliedBy).split(":");
      if (e.relation !== rel) continue;
      const out_ = e.fromId === personId, in_ = e.toId === personId;
      const ok = dir === "out" ? out_ : dir === "in" ? in_ : out_ || in_;
      if (!ok) continue;
      const ctx = nodes.get(out_ ? e.toId : e.fromId);
      if (!ctx) continue;
      const to = isoOf(e.validTo);
      push({ key: r.key, edgeId: e.id, implied: true, context: ctx, from: isoOf(e.validFrom), to, current: !to || new Date(to) > now, status: e.status });
    }
  }
  return out.sort((a, b) => Number(b.current) - Number(a.current) || Number(a.implied) - Number(b.implied) || (b.from ?? "").localeCompare(a.from ?? ""));
}

/** Nearest circles first: a person holding several roles sits in the closest circle any of them implies. */
const CIRCLE_ORDER = ["family", "us", "close", "friends", "school", "care", "clients", "patients", "practice", "team", "manager", "work", "social", "partners", "stakeholders", "suppliers", "network", "other"];

/** The circle a person's current roles put them in (null when they hold none). `circleOf` maps a role to the graph's own circle. */
export function circleFromRoles(m: MetaModel, held: Pick<HeldRole, "key" | "current">[], circleOf: (role: MetaRole) => string | null = (r) => r.circle): string | null {
  let best: string | null = null;
  for (const h of held) {
    if (!h.current) continue;
    const r = findRole(m, h.key);
    const c = r ? circleOf(r) : null;
    if (!c) continue;
    const rank = (x: string) => { const i = CIRCLE_ORDER.indexOf(x); return i === -1 ? CIRCLE_ORDER.length : i; };
    if (best === null || rank(c) < rank(best)) best = c;
  }
  return best;
}

/* ── Finding roles in words (English + Danish) ──────────────────────────────────────────────────────── */

type RoleWord = { role: string; en: string[]; da: string[]; family?: boolean };

/** More specific first: "class teacher" before "teacher", "tandlæge" before "læge", "svigermor" before "mor". */
export const ROLE_WORDS: RoleWord[] = [
  { role: "class_teacher", en: ["class teacher", "form teacher", "homeroom teacher", "form tutor"], da: ["klasselærer", "kontaktlærer", "klasselærerinde"] },
  { role: "school_leader", en: ["principal", "head teacher", "headteacher", "headmaster", "headmistress", "school leader", "deputy head"], da: ["skoleleder", "viceskoleleder", "afdelingsleder", "institutionsleder", "daginstitutionsleder"] },
  { role: "pedagogue", en: ["pedagogue", "nursery teacher", "daycare teacher", "childminder", "kindergarten teacher"], da: ["pædagog", "pædagogmedhjælper", "dagplejer", "dagplejemor", "sfo-pædagog"] },
  { role: "teacher", en: ["teacher", "tutor"], da: ["lærer", "lærerinde", "faglærer", "underviser"] },
  { role: "dentist", en: ["dentist", "dental hygienist", "orthodontist"], da: ["tandlæge", "tandplejer", "tandregulering"] },
  { role: "health_visitor", en: ["health visitor", "school nurse"], da: ["sundhedsplejerske", "skolesundhedsplejerske"] },
  { role: "nurse", en: ["nurse", "midwife"], da: ["sygeplejerske", "jordemoder"] },
  { role: "psychologist", en: ["psychologist", "therapist", "psychotherapist", "counsellor", "counselor", "psychiatrist"], da: ["psykolog", "terapeut", "psykoterapeut", "psykiater"] },
  { role: "doctor", en: ["doctor", "gp", "physician", "paediatrician", "pediatrician", "dr", "dr.", "family doctor"], da: ["læge", "egen læge", "praktiserende læge", "speciallæge", "børnelæge", "overlæge", "lægen"] },
  { role: "babysitter", en: ["babysitter", "baby sitter", "au pair", "nanny", "sitter"], da: ["barnepige", "babysitter"] },
  { role: "coach", en: ["coach", "trainer", "instructor"], da: ["træner", "instruktør", "holdleder"] },
  { role: "landlord", en: ["landlord", "landlady"], da: ["udlejer"] },
  { role: "tenant", en: ["tenant", "lodger"], da: ["lejer"] },
  { role: "neighbour", en: ["neighbour", "neighbor"], da: ["nabo"] },
  { role: "manager", en: ["manager", "boss", "line manager", "supervisor", "team lead"], da: ["chef", "leder", "nærmeste leder", "teamleder"] },
  { role: "colleague", en: ["colleague", "coworker", "co-worker"], da: ["kollega", "kollegaer"] },
  { role: "employee", en: ["employee", "staff member"], da: ["medarbejder", "ansat"] },
  { role: "clinician", en: ["clinician"], da: ["behandler"] },
  { role: "client", en: ["client", "customer"], da: ["klient", "kunde"] },
  { role: "patient", en: ["patient"], da: ["patient"] },
  { role: "classmate", en: ["classmate"], da: ["klassekammerat"] },
  { role: "close_friend", en: ["best friend", "close friend"], da: ["bedste ven", "bedste veninde", "nær ven", "nære ven"] },
  { role: "friend", en: ["friend"], da: ["ven", "veninde"] },
  { role: "in_law", en: ["mother-in-law", "father-in-law", "brother-in-law", "sister-in-law", "in-law"], da: ["svigermor", "svigerfar", "svigerforældre", "svoger", "svigerinde"], family: true },
  { role: "grandparent", en: ["grandmother", "grandfather", "grandma", "grandpa", "granny", "grandparent"], da: ["mormor", "morfar", "farmor", "farfar", "bedstemor", "bedstefar", "oldemor", "oldefar"], family: true },
  { role: "aunt_uncle", en: ["aunt", "uncle"], da: ["moster", "faster", "morbror", "farbror", "onkel", "tante"], family: true },
  { role: "cousin", en: ["cousin"], da: ["fætter", "kusine"], family: true },
  { role: "sibling", en: ["brother", "sister", "sibling"], da: ["bror", "søster", "storebror", "lillebror", "storesøster", "lillesøster", "søskende"], family: true },
  { role: "partner", en: ["wife", "husband", "partner", "spouse", "girlfriend", "boyfriend"], da: ["kone", "hustru", "ægtemand", "kæreste", "samlever"], family: true },
  { role: "parent", en: ["mother", "father", "mum", "mom", "dad", "parent"], da: ["mor", "far", "forælder", "forældre"], family: true },
];

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+");
/** Danish nouns take their article as an ending: læge → lægen, lærer → læreren, pædagog → pædagogen, plus -s for "whose". */
const DA_ENDINGS = "(?:en|n|et|ne|erne|s|ens|ns)?";
const EN_ENDINGS = "(?:s|'s|’s)?";

const alt = (w: RoleWord) => [...w.en.map((x) => esc(x) + EN_ENDINGS), ...w.da.map((x) => esc(x) + DA_ENDINGS)].join("|");
const RES = ROLE_WORDS.map((w) => ({
  ...w,
  re: new RegExp(`(?<![\\p{L}\\p{N}])(?:${alt(w)})(?![\\p{L}\\p{N}])`, "iu"),
  whole: new RegExp(`^(?:${alt(w)})$`, "iu"),
}));

export type RoleHit = { role: string; word: string; index: number; family: boolean };

/** The first role word in a text (English or Danish), most specific role first. */
export function detectRole(text: string | null | undefined): RoleHit | null {
  if (!text) return null;
  let best: RoleHit | null = null;
  for (const w of RES) {
    const m = w.re.exec(text);
    if (!m) continue;
    // A more specific role found at the same place wins (it comes first in the list); otherwise the earliest mention.
    if (!best || m.index < best.index) best = { role: w.role, word: m[0], index: m.index, family: !!w.family };
  }
  return best;
}

/** Every role word in a text, once per role. */
export function detectRoles(text: string | null | undefined): RoleHit[] {
  if (!text) return [];
  const out: RoleHit[] = [];
  const taken: [number, number][] = [];
  for (const w of RES) {
    const re = new RegExp(w.re.source, "giu");
    for (const m of text.matchAll(re)) {
      const s = m.index ?? 0, e = s + m[0].length;
      if (taken.some(([a, b]) => s < b && e > a)) continue; // "klasselærer" already took "lærer"
      taken.push([s, e]);
      if (!out.some((h) => h.role === w.role)) out.push({ role: w.role, word: m[0], index: s, family: !!w.family });
    }
  }
  return out.sort((a, b) => a.index - b.index);
}

const DETERMINERS_EN = /^(?:the|a|an|our|my|your|his|her|their|its|this|that)\s+/i;
const DETERMINERS_DA = /^(?:en|et|den|det|vores|min|mit|mine|din|dit|hans|hendes|deres|sin|sit)\s+/i;
const SPEAKER = /^(?:unknown\s+)?(?:speaker|participant|attendee|caller|ukendt\s+taler|taler|deltager|ukendt)\s*[#]?\s*(?:\d{1,3}|[a-z])?$/iu;
const POSSESSIVE = /^([\p{Lu}][\p{L}.\- ]{0,40}?)(?:'s|’s|s)\s+/u;

export type RoleMention = {
  /** The role named, or null for a placeholder like "Speaker 2". */
  role: string | null;
  /** "Emma's teacher" → "Emma"; "the teacher of 3.B" → "3.B". */
  contextHint: string | null;
};

/**
 * Is this "person" really just a role, with nobody named? "the teacher", "Lægen", "vores nabo", "Emma's teacher",
 * "klasselæreren i 3.B", "Speaker 2". A name next to the role ("Dr. Mette Lund", "lærer Karen") is a person. Bare family
 * words ("Mormor", "Dad") are how families name one person, so they count as names unless a determiner says otherwise.
 */
export function roleMention(label: string | null | undefined): RoleMention | null {
  const raw = (label ?? "").normalize("NFKC").replace(/\s+/g, " ").trim().replace(/[.,:;!?]+$/, "");
  if (!raw || raw.length > 80) return null;
  if (SPEAKER.test(raw)) return { role: null, contextHint: null };
  let s = raw, determiner = false, contextHint: string | null = null;
  const det = DETERMINERS_EN.exec(s) ?? DETERMINERS_DA.exec(s);
  if (det) { s = s.slice(det[0].length); determiner = true; }
  const pos = POSSESSIVE.exec(s);
  if (pos && !det) {
    // "Emma's teacher" / "Emmas lærer": only when what follows is a role
    const rest = s.slice(pos[0].length);
    if (wholeRole(rest)) { contextHint = pos[1].trim(); s = rest; determiner = true; }
  }
  const tail = /\s+(?:of|at|for|in|på|i|hos|til|fra)\s+(.{1,40})$/iu.exec(s);
  if (tail && wholeRole(s.slice(0, tail.index))) { contextHint = contextHint ?? tail[1].trim(); s = s.slice(0, tail.index); }
  const role = wholeRole(s);
  if (!role) return null;
  const w = ROLE_WORDS.find((x) => x.role === role)!;
  // Danish definite form ("Lægen", "Naboen") names nobody; a bare family word ("Mormor") is a name.
  const definite = /(?:en|et|ne|erne)$/iu.test(s) && !w.da.some((d) => d.toLowerCase() === s.toLowerCase()) && !w.en.some((d) => d.toLowerCase() === s.toLowerCase());
  if (w.family && !determiner && !definite) return null;
  return { role, contextHint };
}

/** The role when the whole text is one role word (any form), else null. */
function wholeRole(s: string): string | null {
  const t = s.trim();
  if (!t) return null;
  for (const w of RES) if (w.whole.test(t)) return w.role;
  return null;
}
