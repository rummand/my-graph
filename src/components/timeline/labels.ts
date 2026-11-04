/** Labels for the timeline's statuses, kinds and marks, as message keys. Pure, so tests can check them. */
import type { ItemStatus, TimelineItem } from "@/lib/timeline/types";

/** Message keys (timeline.status.*, timeline.kind.*, timeline.marks.*): translate with t(). */
export const STATUS_LABEL: Record<ItemStatus, string> = {
  confirmed: "timeline.status.confirmed",
  unconfirmed: "timeline.status.unconfirmed",
  inferred: "timeline.status.inferred",
};

export const KIND_LABEL: Record<TimelineItem["kind"], string> = {
  event: "timeline.kind.event",
  reminder: "timeline.kind.reminder",
  source: "timeline.kind.source",
  document: "timeline.kind.document",
  thread: "timeline.kind.thread",
};

/** Every mark the screen can draw. */
export type MarkKind = "confirmed" | "unconfirmed" | "inferred" | "span" | "fuzzy" | "reminder" | "overdue" | "upload" | "document" | "mail";

export const MARK_LABEL: Record<MarkKind, string> = {
  confirmed: "timeline.marks.confirmed",
  unconfirmed: "timeline.marks.unconfirmed",
  inferred: "timeline.marks.inferred",
  span: "timeline.marks.span",
  fuzzy: "timeline.marks.fuzzy",
  reminder: "timeline.marks.reminder",
  overdue: "timeline.marks.overdue",
  upload: "timeline.marks.upload",
  document: "timeline.marks.document",
  mail: "timeline.marks.mail",
};

