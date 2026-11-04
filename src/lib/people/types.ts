/** People data shapes shared by server, API and client components (JSON-safe: dates are ISO strings). */
import type { AttentionItem } from "./attention";
import type { MetaAttribute, MetaKind, MetaRelation } from "@/lib/meta/types";
import type { RoleParts } from "./relpath";

export type { AttentionItem } from "./attention";
export type { RoleParts } from "./relpath";

export type Visibility = "private" | "parents" | "household";
export type ObservationKind = "wellbeing" | "health" | "milestone" | "contact" | "note";

export type WellbeingPoint = { score: number; at: string; note: string | null; sensitive?: boolean };

export type PersonSummary = {
  id: string;
  label: string;
  kind: string | null;
  kindLabel: string | null;
  circle: string;
  visibility: Visibility;
  sensitive: boolean;
  ownerId: string;
  /** A member of the current graph (has a login and is in this graph; in the family graph: the household). */
  householdMember: boolean;
  isViewer: boolean;
  relation: { label: string; role?: RoleParts; hops: 1 | 2; via: { id: string; label: string } | null; relation: string; category: string } | null;
  lastContactAt: string | null;
  lastContactSource: "contact" | "event" | null;
  contactCount90: number;
  /** Oldest → newest, at most 8. */
  wellbeing: WellbeingPoint[];
  birthday: string | null;
  nextBirthday: { date: string; daysUntil: number; turning: number | null } | null;
  openReminders: number;
  createdAt: string;
};

export type CenterOption = { id: string; label: string; isViewer: boolean };

export type PeopleOverview = {
  center: CenterOption | null;
  centers: CenterOption[];
  people: PersonSummary[];
  attention: AttentionItem[];
  kinds: Pick<MetaKind, "key" | "label" | "circle">[];
  /** The graph's template kind (family, work, personal …): which circles it draws and how it words things. */
  template: string;
  /** Family rules (parents, children, household) apply in this graph. */
  family: boolean;
  generatedAt: string;
};

export type Observation = {
  id: string; personNodeId: string; ownerId: string; kind: ObservationKind; score: number | null; note: string | null;
  tags: string[]; at: string; sourceId: string | null; authorKind: "user" | "assistant"; visibility: Visibility; sensitive: boolean;
  authorName: string | null;
  /** Logged by the person looking. */
  byViewer?: boolean;
};

/**
 * Where something came from. `code` says what kind of citation it is when the title is generic, so the UI can word it
 * in the reader's language ("Added by hand" / "Tilføjet i hånden"); `who` is the person who logged it.
 */
export type Citation = {
  title: string; href: string; detail?: string; confidence?: number;
  code?: "by_hand" | "assistant" | "rule" | "hidden_source" | "source" | "logged_by" | "logged_by_hand"; who?: string;
};

export type FeedItem = {
  id: string;
  at: string;
  type: "observation" | "event" | "document";
  title: string;
  detail: string | null;
  href: string | null;
  observationKind?: ObservationKind;
  score?: number | null;
  /** Contact observations: talked, met, messaged. */
  tags?: string[];
  /** Documents: whether it is about them or mentions them. */
  docRelation?: "about" | "mentions";
  citations: Citation[];
};

export type RelationshipItem = {
  edgeId: string;
  relation: string;
  /** From this person's side: "child of", "teacher of", "attends". */
  label: string;
  direction: "out" | "in";
  /** When the other end is you: how this person relates to you ("Your manager", "Knows you"). */
  toYou: string | null;
  toYouRole?: RoleParts | null;
  other: { id: string; label: string; type: string; kind: string | null; kindLabel: string | null };
  status: string;
  confidence: number;
  citations: Citation[];
};

export type RelationshipGroup = { category: string; label: string; items: RelationshipItem[] };

export type NodeOption = { id: string; label: string; type: string; kind: string | null; isViewer?: boolean };

export type PersonProfile = {
  person: PersonSummary & { props: Record<string, unknown>; summary: string | null; aliases: string[]; canEdit: boolean; createdAt: string };
  attributes: MetaAttribute[];
  relationships: RelationshipGroup[];
  observations: Observation[];
  milestones: { id: string; at: string; title: string; href: string | null; source: "observation" | "event"; untitled?: boolean }[];
  feed: FeedItem[];
  relationOptions: MetaRelation[];
  kinds: MetaKind[];
  nodeOptions: NodeOption[];
  provenance: Citation[];
  viewer: { id: string; role: string; isParent: boolean };
  graph: { template: string; family: boolean };
};

export const VISIBILITY_LABELS: Record<Visibility, string> = { private: "Only me", parents: "Parents", household: "Whole household" };
