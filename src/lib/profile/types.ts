/**
 * Living profile shapes shared by the server, the API and client components (JSON-safe: dates are ISO strings).
 * A profile is a node's page laid out in sections (derived from its type and kind); facts from the graph render as
 * blocks inside them, agents' pending proposals show beside them, and the written part is a versioned profile doc.
 */
import type { ProfileDoc } from "./doc";

export type SectionKey =
  | "overview" | "family" | "home" | "pets" | "school" | "work" | "interests" | "dates" | "care" | "people"
  | "organisations" | "projects" | "places" | "events" | "dependencies" | "documents" | "connections" | "notes";

/** A section of a profile: `core` sections always show (with an empty state); the others only when they have facts. */
export type SectionDef = { key: SectionKey; core: boolean; presets: FactPresetKey[] };

/** One-click facts offered in a section ("Add a pet", "Add a child"). */
export type FactPresetKey =
  | "partner" | "child" | "parent" | "sibling" | "pet" | "home" | "car" | "belonging" | "workplace" | "school"
  | "interest" | "doctor" | "friend" | "member" | "project" | "place" | "relation";

/** Where a fact came from, as a chip (same codes as people citations so they word the same). */
export type ProvChip = {
  title: string; href?: string; detail?: string; confidence?: number; quote?: string;
  code?: "by_hand" | "assistant" | "rule" | "hidden_source" | "source";
};

/** How a fact reads from the profile's side: "Has a dog" (owns + kind) or the relation phrase ("child of"). */
export type FactPhrase = { kind: "has"; what: string } | { kind: "rel"; label: string };

export type FactBlock = {
  edgeId: string;
  section: SectionKey;
  relation: string;
  direction: "out" | "in";
  phrase: FactPhrase;
  other: { id: string; label: string; type: string; kind: string | null; kindLabel: string | null; href: string };
  status: "confirmed" | "unconfirmed" | "inferred" | "rejected" | "superseded";
  confidence: number;
  provenance: ProvChip[];
};

/** A proposal waiting in a change set that mentions this node, shown inline in a section. */
export type SuggestionBlock = {
  changeSetId: string;
  changeId: string;
  /** The ops to deliver together for this one suggestion (the fact plus the new things it needs). */
  changeIds: string[];
  section: SectionKey;
  title: string;
  summary: string;
  origin: string;
  /** Other proposals in the same set that are not about this node. */
  otherCount: number;
  receipt: { quote?: string; sourceId?: string; url?: string };
  createdAt: string;
};

/** A profile doc proposal ("Restore as a proposal"), waiting for a person. */
export type DocProposal = { id: string; basedOn: number | null; createdAt: string; createdByName: string | null };

export type DocVersion = {
  id: string; version: number; event: "saved" | "restored" | "proposed" | "delivered" | "dropped";
  basedOn: number | null; createdAt: string; createdByName: string | null; authorKind: string; chars: number;
};

export type ProfileSection = SectionDef & { facts: FactBlock[]; suggestions: SuggestionBlock[] };

export type ProfileView = {
  node: { id: string; label: string; type: string; kind: string | null; kindLabel: string | null; summary: string | null; aliases: string[]; visibility: string; sensitive: boolean };
  sections: ProfileSection[];
  doc: { doc: ProfileDoc; version: number; updatedAt: string | null; updatedByName: string | null; proposals: DocProposal[] };
  canEdit: boolean;
  canWrite: boolean;
  /** The viewer may decide the graph's model (new kinds and relation types land without a second review). */
  canGrowModel: boolean;
  insights: boolean;
  /** Relation options (key, direction, phrase) between this node and each other type, for the fact form. */
  presets: { key: FactPresetKey; relation: string; direction: "out" | "in"; otherType: string; kind: string | null }[];
  /** Every connection this node can have, read from its side ("parent of", "child of"), for "Add a connection". */
  relations: { key: string; direction: "out" | "in"; phrase: string; otherTypes: string[]; category: string }[];
  /** The graph is a family graph (family wording). */
  family: boolean;
};

/* ── Insights ─────────────────────────────────────────────────────────────────────────────────────────── */

export type EvidenceKind = "checkin" | "observation" | "chat" | "document" | "note" | "event";

/** One piece of evidence the viewer may read: what the model sees, and where the line links to. */
export type Evidence = { id: string; kind: EvidenceKind; at: string | null; title: string; text: string; href: string };

export type InsightArea = "stress" | "health" | "mood" | "event" | "school" | "work" | "relationships" | "other";

export type InsightLine = { at: string | null; area: InsightArea; text: string; evidence: string[] };

export type Insights = {
  timeline: InsightLine[];
  matters: { text: string; evidence: string[] }[];
  followUps: { text: string; evidence: string[] }[];
};

export type InsightsView = {
  status: "ready" | "none" | "empty" | "mux_down" | "off";
  insights: Insights | null;
  evidence: Evidence[];
  generatedAt: string | null;
  /** New evidence arrived since these were generated. */
  stale: boolean;
  dropped: number;
  model: string | null;
};
