/**
 * Shapes shared by the search API, the ⌘K palette and the /search page. Pure (no server imports), so the client may
 * import it.
 */

/** Sections the server searches, in the order they are shown. */
export const SECTIONS = ["nodes", "commitments", "made", "files", "rules", "chats", "changes", "events"] as const;
export type Section = (typeof SECTIONS)[number];

export function isSection(x: unknown): x is Section {
  return typeof x === "string" && (SECTIONS as readonly string[]).includes(x);
}

/** [start, end) offsets into a string (UTF-16 code units, as JavaScript indexes strings). */
export type Range = [number, number];

/** What kind of thing a hit is: drives its icon and its context line. */
export type HitKind =
  | "person" | "place" | "organization" | "event" | "topic" | "project" | "thing"
  | "commitment"
  | "page" | "document" | "deck"
  | "file"
  | "rule" | "definition" | "ruleset"
  | "chat"
  | "change";

export type Hit = {
  /** Unique across sections: "<kind>:<id>". */
  key: string;
  section: Section;
  kind: HitKind;
  id: string;
  title: string;
  /** Where it opens (a passage anchor for files, the rule's place in its rule set). */
  href: string;
  /** Matched letters in the title (the client may also recompute these). */
  titleRanges: Range[];
  /** Short, already-translated words for the context line ("Teacher", "PDF", "Lejeloven § 182"). */
  context: string[];
  /** A passage around the match, with highlight offsets; never present for someone else's sensitive item. */
  snippet?: { text: string; ranges: Range[] } | null;
  /** Page / slide / time of the matched passage, for the context line. */
  locator?: { page?: number; slide?: number; time?: number; sheet?: string } | null;
  /** Node type / mime / rule kind: fine detail for the icon. */
  sub?: string | null;
  /** Colour seed (people colours: the person's node id). */
  colorId?: string | null;
  /** ISO date that makes sense for this item (event start, document date, last change). */
  date?: string | null;
  ownerName?: string | null;
  /** Someone else's sensitive item: found by name, its words are not shown. */
  sensitive?: boolean;
  /** 0..100 relevance (see rank.ts tiers). */
  score: number;
  /** How it matched: title, alias, text, meaning. */
  via: "title" | "alias" | "text" | "meaning";
};

export type SectionResult = { id: Section; items: Hit[]; more: boolean };

export type SearchResponse = {
  q: string;
  /** The parsed type filter, when the query started with one ("person:", "fil:"). */
  filter: { sections: Section[]; label: string | null } | null;
  top: Hit | null;
  sections: SectionResult[];
  /** Whether meaning-based (embedding) results were included. */
  semantic: boolean;
  ms: number;
};

export type SearchMode = "quick" | "full";
