/** Meta-model types shared by server code, API routes and client components (no server imports here). */

export type MetaNodeType = "person" | "place" | "event" | "topic" | "document" | "source";
export const META_NODE_TYPES: MetaNodeType[] = ["person", "place", "event", "topic", "document", "source"];

export type AttrType = "text" | "longtext" | "date" | "number" | "boolean" | "enum" | "email" | "phone" | "url";
export const ATTR_TYPES: AttrType[] = ["text", "longtext", "date", "number", "boolean", "enum", "email", "phone", "url"];

export type Circle = "family" | "close" | "school" | "care" | "social" | "work" | "other";
export const CIRCLES: Circle[] = ["family", "close", "school", "care", "social", "work", "other"];

export type RelationCategory = "family" | "social" | "care" | "school" | "work" | "place" | "time" | "document" | "other";
export const RELATION_CATEGORIES: RelationCategory[] = ["family", "social", "care", "school", "work", "place", "time", "document", "other"];

/**
 * Where a merged row comes from:
 *  builtin   — shipped default (householdId null), untouched
 *  override  — a built-in the household changed (household row with the same key)
 *  household — the household's own addition
 */
export type MetaOrigin = "builtin" | "override" | "household";

/** Common to merged rows: `householdRowId` is the household's own row (override, addition or hide tombstone), if any. */
type Merged = { origin: MetaOrigin; hidden: boolean; householdRowId: string | null };

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

/** The merged ontology for one household. Includes hidden built-ins (flagged) so the model editor can un-hide them. */
export type MetaModel = { kinds: MetaKind[]; relations: MetaRelation[]; attributes: MetaAttribute[] };

export type PropError = { key: string; label: string; code: "required" | "invalid_type" | "invalid_value" | "too_long"; message: string };
export type ValidateResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; errors: PropError[] };

export const CIRCLE_LABELS: Record<Circle, string> = {
  family: "Family", close: "Close friends", school: "School & daycare", care: "Care & health", social: "Friends & neighbours", work: "Work", other: "Others",
};

export const CATEGORY_LABELS: Record<string, string> = {
  family: "Family", social: "Friends & social", care: "Care & health", school: "School", work: "Work",
  place: "Places", time: "Time", document: "Documents & sources", other: "Other",
};
