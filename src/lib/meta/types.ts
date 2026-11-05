/** Meta-model types shared by server code, API routes and client components (no server imports here). */

export type MetaNodeType = "person" | "place" | "event" | "topic" | "document" | "source" | "organization" | "project" | "thing" | "commitment";
export const META_NODE_TYPES: MetaNodeType[] = ["person", "place", "event", "topic", "document", "source", "organization", "project", "thing", "commitment"];

/** Node types a person picks between (documents and sources are made by the library). */
export const PICKABLE_NODE_TYPES: MetaNodeType[] = ["person", "organization", "project", "place", "event", "topic", "thing"];

export const NODE_TYPE_LABELS: Record<MetaNodeType, { one: string; many: string }> = {
  person: { one: "Person", many: "People" }, place: { one: "Place", many: "Places" }, event: { one: "Event", many: "Events" },
  topic: { one: "Topic", many: "Topics" }, document: { one: "Document", many: "Documents" }, source: { one: "Source", many: "Sources" },
  organization: { one: "Organisation", many: "Organisations" }, project: { one: "Project", many: "Projects" }, thing: { one: "Thing", many: "Things" },
  commitment: { one: "Commitment", many: "Commitments" },
};

export type AttrType = "text" | "longtext" | "date" | "number" | "boolean" | "enum" | "email" | "phone" | "url";
export const ATTR_TYPES: AttrType[] = ["text", "longtext", "date", "number", "boolean", "enum", "email", "phone", "url"];

export type Circle = "family" | "close" | "school" | "care" | "social" | "work" | "other";
export const CIRCLES: Circle[] = ["family", "close", "school", "care", "social", "work", "other"];
/** Circles graph templates add (a Work graph groups people by team, managers, clients …). */
export type TemplateCircle = "team" | "manager" | "clients" | "partners" | "network" | "us" | "friends" | "places" | "stakeholders" | "suppliers";
export const ALL_CIRCLES: (Circle | TemplateCircle)[] = [...CIRCLES, "team", "manager", "clients", "partners", "network", "us", "friends", "places", "stakeholders", "suppliers"];

export type RelationCategory = "family" | "social" | "care" | "school" | "work" | "place" | "time" | "document" | "other";
export const RELATION_CATEGORIES: RelationCategory[] = ["family", "social", "care", "school", "work", "place", "time", "document", "other"];

/**
 * Where a merged row comes from:
 *  builtin   — shipped default (householdId null), untouched
 *  override  — a built-in the household changed (household row with the same key)
 *  household — the household's own addition
 */
export type MetaOrigin = "builtin" | "override" | "household";

/** Emergent meta model: a row starts as a candidate (proposed from evidence), becomes active, or is hidden. */
export type MetaStatus = "candidate" | "active" | "hidden";
/** Where the row itself came from (the DB `origin` column). */
export type MetaSource = "builtin" | "template" | "manual" | "emergent";
export const META_STATUSES: MetaStatus[] = ["candidate", "active", "hidden"];

/** Emergent-model columns. Optional on rows so older fixtures and callers keep working. */
export type EmergentFields = {
  status?: MetaStatus; source?: MetaSource; graphId?: string | null; evidenceCount?: number; firstSeenAt?: Date | string | null;
  changeSetId?: string | null; createdAt?: Date | string | null;
};

/**
 * Common to merged rows: `householdRowId` is the household's own row (override, addition or hide tombstone), if any.
 * `offTemplate`: a built-in the graph's template doesn't use (a pedagogue in a Work graph). It is hidden from pickers
 * but still labels old data.
 */
type Merged = { origin: MetaOrigin; hidden: boolean; householdRowId: string | null; offTemplate?: boolean } & EmergentFields;

export type MetaKind = {
  id: string; householdId: string | null; nodeType: MetaNodeType; key: string; label: string;
  pluralLabel: string | null; description: string | null; circle: string | null; parentKey: string | null;
  icon: string | null; color: string | null; sortOrder: number; builtin: boolean;
} & Merged;

export type MetaRelation = {
  id: string; householdId: string | null; key: string; label: string; inverseLabel: string; category: string;
  fromTypes: string[]; toTypes: string[]; symmetric: boolean; builtin: boolean;
} & Merged;

export type MetaAttribute = {
  id: string; householdId: string | null; nodeType: MetaNodeType; kindKey: string | null; key: string; label: string;
  dataType: AttrType; options: string[]; required: boolean; sensitive: boolean; sortOrder: number; builtin: boolean;
} & Merged;

/**
 * A role: a position or function a person holds (doctor, class teacher, client, landlord), apart from who they are.
 * Held as an edge `person —role:<key>→ context` (see src/lib/meta/roles.ts). Wording in English and Danish.
 */
export type MetaRole = {
  id: string; householdId: string | null; key: string; label: string; pluralLabel: string | null;
  /** "Doctor at …", "Class teacher of …" */
  preposition: string; inverseLabel: string | null;
  labelDa: string | null; pluralLabelDa: string | null; prepositionDa: string | null; inverseLabelDa: string | null;
  description: string | null;
  /** Node types or "type:kind" a role can be held in; empty = anything. */
  contextTypes: string[];
  circle: string | null;
  /** "parent_of:out": a relation edge already says it (shown as a role, never stored as one). */
  impliedBy: string | null;
  parentKey: string | null; icon: string | null; sortOrder: number; builtin: boolean;
} & Merged;

/** The merged ontology for one household. Includes hidden built-ins (flagged) so the model editor can un-hide them. */
export type MetaModel = {
  kinds: MetaKind[]; relations: MetaRelation[]; attributes: MetaAttribute[];
  /** Roles people hold (optional so older fixtures keep working; the server always fills it). */
  roles?: MetaRole[];
  /** Proposed from evidence, not yet accepted: shown on "How this graph sees the world", never in pickers. */
  candidates?: { kinds: MetaKind[]; relations: MetaRelation[]; attributes: MetaAttribute[]; roles?: MetaRole[] };
  /** The graph this model was read for (null = household-wide). */
  graphId?: string | null;
};

export type PropError = { key: string; label: string; code: "required" | "invalid_type" | "invalid_value" | "too_long"; message: string };
export type ValidateResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; errors: PropError[] };

export const CIRCLE_LABELS: Record<Circle, string> = {
  family: "Family", close: "Close friends", school: "School & daycare", care: "Care & health", social: "Friends & neighbours", work: "Work", other: "Others",
};

export const ALL_CIRCLE_LABELS: Record<string, string> = {
  ...CIRCLE_LABELS, team: "Team", manager: "Managers", clients: "Clients", partners: "Partners", network: "Network",
  us: "Us", friends: "Friends", places: "Our places", stakeholders: "Stakeholders", suppliers: "Suppliers",
};

export const CATEGORY_LABELS: Record<string, string> = {
  family: "Family", social: "Friends & social", care: "Care & health", school: "School", work: "Work",
  place: "Places", time: "Time", document: "Documents & sources", other: "Other",
};
