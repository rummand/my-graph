/** Plain-English labels for provenance and facts. Pure — shared by server and client components. */
import { format } from "date-fns";
import type { Locator } from "@/db/schema";

export type ProvenanceView = {
  id: string; sourceId: string | null; sourceTitle: string | null; locator: Locator; quote: string | null;
  activity: string; agentType: string; agentId: string; confidence: number; note: string | null; createdAt: string | Date;
};

const ACTIVITY: Record<string, string> = {
  upload: "Uploaded",
  ocr: "Read from a scan (OCR)",
  transcription: "Transcribed from audio",
  llm_extraction: "Picked out by the assistant",
  manual_edit: "Entered by hand",
  inference: "Guessed by the assistant",
  import: "Imported",
};

export function activityLabel(a: string): string {
  return ACTIVITY[a] ?? a.replace(/_/g, " ");
}

/** "Anna", "Assistant (claude-sonnet)", "Rule: birthday", or a fallback for people no longer in the household. */
export function agentLabel(agentType: string, agentId: string, names: Record<string, string> = {}): string {
  if (agentType === "user") return names[agentId] ?? "A former member";
  if (agentType === "model") {
    const model = agentId.replace(/^mux:/, "");
    return model ? `Assistant (${model})` : "Assistant";
  }
  return `Rule: ${agentId.replace(/^rule:/, "").replace(/_/g, " ")}`;
}

/** "page 3", "0:42–1:05", or "" when the locator says nothing a person can use. */
export function locatorLabel(l: Locator | null | undefined): string {
  if (!l) return "";
  const parts: string[] = [];
  if (typeof l.page === "number") parts.push(`page ${l.page}`);
  if (typeof l.timeStartSec === "number") {
    const t = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
    parts.push(typeof l.timeEndSec === "number" ? `${t(l.timeStartSec)}–${t(l.timeEndSec)}` : t(l.timeStartSec));
  }
  return parts.join(", ");
}

export function confidenceLabel(c: number): string {
  if (c >= 0.9) return "High confidence";
  if (c >= 0.6) return "Fairly confident";
  return "Low confidence";
}

export const STATUS_LABEL: Record<string, string> = {
  confirmed: "Confirmed",
  unconfirmed: "Not yet confirmed",
  inferred: "A guess",
  rejected: "Marked wrong",
  superseded: "Replaced",
};

export const VISIBILITY_LABEL: Record<string, string> = {
  private: "Only the owner",
  parents: "Parents",
  household: "Whole household",
};

export const TYPE_LABEL: Record<string, string> = {
  person: "Person", place: "Place", event: "Event", topic: "Topic", document: "Document", source: "Source",
};

export function relationLabel(r: string): string {
  return r.replace(/_/g, " ");
}

/** "parent of" → "Parent of", for headings. */
export function sentenceCase(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/** "92% sure": how sure we are, as people say it. */
export function percentSure(c: number): string {
  return `${Math.round(c * 100)}% sure`;
}

/**
 * Who recorded a piece of evidence and how, as one phrase: "Uploaded by Anna", "Picked out by the assistant
 * (qwen3-local)", "Entered by Anna", "Guessed by rule: birthday".
 */
export function provenanceByline(activity: string, agentType: string, agentId: string, names: Record<string, string> = {}): string {
  const how = activityLabel(activity);
  if (agentType === "user") {
    const who = agentLabel(agentType, agentId, names);
    if (activity === "manual_edit") return `Entered by ${who}`;
    return `${how} by ${who}`;
  }
  if (agentType === "model") {
    const model = agentId.replace(/^mux:/, "");
    const base = /assistant/i.test(how) ? how : `${how} by the assistant`;
    return model ? `${base} (${model})` : base;
  }
  return `${how}, ${agentLabel(agentType, agentId, names).replace(/^Rule/, "rule")}`;
}

/** A node's place in time, at the precision we know it. */
export function formatWhen(start: Date | string | null, end: Date | string | null, precision: string | null): string {
  if (!start) return "";
  const pattern = precision === "year" ? "yyyy" : precision === "month" ? "MMMM yyyy" : precision === "minute" ? "d MMMM yyyy, HH:mm" : "d MMMM yyyy";
  const s = format(new Date(start), pattern);
  if (!end) return s;
  const e = format(new Date(end), pattern);
  if (precision === "minute" && format(new Date(start), "yyyy-MM-dd") === format(new Date(end), "yyyy-MM-dd")) {
    return `${s}–${format(new Date(end), "HH:mm")}`;
  }
  return e === s ? s : `${s} – ${e}`;
}

export function formatDate(d: Date | string): string {
  return format(new Date(d), "d MMM yyyy");
}

/** "Mon 16 Nov 2026" for a single day, as shown in headers. */
export function formatDay(d: Date | string): string {
  return format(new Date(d), "EEE d MMM yyyy");
}
