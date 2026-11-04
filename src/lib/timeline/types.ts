/** Timeline data shapes shared by the server, the API and client components (JSON-safe: dates are ISO strings). */

export type TimePrecision = "minute" | "day" | "month" | "year";
export type ItemStatus = "confirmed" | "unconfirmed" | "inferred";
export type ItemKind = "event" | "reminder" | "source" | "document" | "thread";

/** What a dated document is (library docKind). */
export type DocKind = "mail" | "letter" | "scan" | "photo" | "recording" | "note" | "file";

export type ThreadMessage = { sourceId: string; at: string; from: string | null; fromPersonId: string | null; title: string };
export type ThreadInfo = {
  key: string;
  subject: string;
  messages: ThreadMessage[];
  participants: { name: string; email: string; personId: string | null }[];
};

export type TimelineItem = {
  /** Unique within a response: `event:<nodeId>`, `reminder:<id>`, `source:<id>`. */
  id: string;
  kind: ItemKind;
  title: string;
  summary: string | null;
  start: string;
  /** Spans only; null for point events. */
  end: string | null;
  precision: TimePrecision | null;
  status: ItemStatus;
  /** Lane ids this item appears in (person node ids, or "family"). Never empty. */
  laneIds: string[];
  /** Person node ids involved (may include people without a lane when a person filter is active). */
  personIds: string[];
  /** Graph node behind the item (events, and reminders/sources that point at one). */
  nodeId: string | null;
  sourceId: string | null;
  sensitive: boolean;
  /** Reminders only: due in the past and not done. */
  overdue?: boolean;
  /** Documents: letter, scan, photo… (threads are mail). */
  docKind?: DocKind;
  /** Threads only: the conversation, messages in order. */
  thread?: ThreadInfo;
};

export type LaneKind = "viewer" | "child" | "member" | "person" | "family";

export type Lane = {
  /** Person node id, or "family" (the shared lane: "Family" in a family graph, "Everyone" elsewhere). */
  id: string;
  label: string;
  kind: LaneKind;
  birthYear: number | null;
};

export type TopicOption = { id: string; label: string };

export type TimelineData = {
  lanes: Lane[];
  items: TimelineItem[];
  topics: TopicOption[];
  /** Everyone who could be a lane, for the person filter chips (same order as lanes). */
  people: Lane[];
  /** True when the event limit cut results off — narrow the window to see everything. */
  truncated: boolean;
  from: string | null;
  to: string | null;
  generatedAt: string;
};

export const FAMILY_LANE = "family";
