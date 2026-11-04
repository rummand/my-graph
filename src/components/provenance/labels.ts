/** Plain-English labels for provenance and facts. Pure — shared by server and client components. */
import { format } from "date-fns";
import type { Locator } from "@/db/schema";
import { makeT, type Locale, type TFn } from "@/lib/i18n/core";
import { dateLocale } from "@/lib/i18n/dates";
import en from "@/lib/i18n/messages/en";

export type ProvenanceView = {
  id: string; sourceId: string | null; sourceTitle: string | null; locator: Locator; quote: string | null;
  activity: string; agentType: string; agentId: string; confidence: number; note: string | null; createdAt: string | Date;
};

/** English over the bundled dictionary: the default when a caller has no translator (tests, old call sites). */
export const EN: TFn = makeT("en", en);

const ACTIVITIES = ["upload", "ocr", "transcription", "llm_extraction", "manual_edit", "inference", "import"];
/** Activities whose label already says the assistant did it. */
const BY_ASSISTANT = new Set(["llm_extraction", "inference"]);

export function activityLabel(a: string, t: TFn = EN): string {
  return ACTIVITIES.includes(a) ? t(`graph.prov.activity.${a}`) : a.replace(/_/g, " ");
}

/** "Anna", "Assistant (claude-sonnet)", "Rule: birthday", or a fallback for people no longer in the graph. */
export function agentLabel(agentType: string, agentId: string, names: Record<string, string> = {}, t: TFn = EN): string {
  if (agentType === "user") return names[agentId] ?? t("graph.prov.formerMember");
  if (agentType === "model") {
    // "change:<id>" marks a fact that came in through a delivered proposal; the proposal, not the id, is what to show.
    const model = agentId.startsWith("change:") ? "" : agentId.replace(/^mux:/, "");
    return model ? t("graph.prov.assistantModel", { model }) : t("graph.prov.assistant");
  }
  return t("graph.prov.rule", { name: agentId.replace(/^rule:/, "").replace(/_/g, " ") });
}

/** "page 3", "0:42–1:05", or "" when the locator says nothing a person can use. */
export function locatorLabel(l: Locator | null | undefined, t: TFn = EN): string {
  if (!l) return "";
  const parts: string[] = [];
  if (typeof l.page === "number") parts.push(t("graph.prov.page", { n: l.page }));
  if (typeof l.timeStartSec === "number") {
    const tm = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
    parts.push(typeof l.timeEndSec === "number" ? `${tm(l.timeStartSec)}–${tm(l.timeEndSec)}` : tm(l.timeStartSec));
  }
  return parts.join(", ");
}

export function confidenceLabel(c: number, t: TFn = EN): string {
  if (c >= 0.9) return t("graph.prov.confidenceHigh");
  if (c >= 0.6) return t("graph.prov.confidenceFair");
  return t("graph.prov.confidenceLow");
}

const STATUSES = ["confirmed", "unconfirmed", "inferred", "rejected", "superseded"];
export function statusLabel(status: string, t: TFn = EN): string {
  return STATUSES.includes(status) ? t(`graph.status.${status}`) : status;
}
/** English status labels (kept for older call sites). */
export const STATUS_LABEL: Record<string, string> = Object.fromEntries(STATUSES.map((s) => [s, statusLabel(s)]));

export const VISIBILITIES = ["private", "parents", "household"] as const;
/** Who can see an item, in this graph's words: family rules in the family graph, graph roles elsewhere. */
export function visibilityLabel(v: string, family: boolean, t: TFn = EN): string {
  return (VISIBILITIES as readonly string[]).includes(v) ? t(`graph.visibility.${family ? "family" : "other"}.${v}`) : v;
}
/** English family-graph labels (kept for older call sites). */
export const VISIBILITY_LABEL: Record<string, string> = Object.fromEntries(VISIBILITIES.map((v) => [v, visibilityLabel(v, true)]));

const NODE_TYPES_KNOWN = ["person", "place", "event", "topic", "document", "source", "organization", "project", "thing"];
export function typeLabel(type: string, t: TFn = EN): string {
  return NODE_TYPES_KNOWN.includes(type) ? t(`graph.type.${type}`) : type;
}
export function typePlural(type: string, t: TFn = EN): string {
  return NODE_TYPES_KNOWN.includes(type) ? t(`graph.typePlural.${type}`) : type;
}
export const TYPE_LABEL: Record<string, string> = Object.fromEntries(NODE_TYPES_KNOWN.map((x) => [x, typeLabel(x)]));

export function relationLabel(r: string): string {
  return r.replace(/_/g, " ");
}

/** "parent of" → "Parent of", for headings. */
export function sentenceCase(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/** "92% sure": how sure we are, as people say it. */
export function percentSure(c: number, t: TFn = EN): string {
  return t("graph.prov.sure", { pct: Math.round(c * 100) });
}

/**
 * Who recorded a piece of evidence and how, as one phrase: "Uploaded by Anna", "Picked out by the assistant
 * (qwen3-local)", "Entered by Anna", "Guessed by the assistant, rule: birthday".
 */
export function provenanceByline(activity: string, agentType: string, agentId: string, names: Record<string, string> = {}, t: TFn = EN): string {
  const how = activityLabel(activity, t);
  if (agentType === "user") {
    const who = agentLabel(agentType, agentId, names, t);
    if (activity === "manual_edit") return t("graph.prov.enteredBy", { who });
    return t("graph.prov.howBy", { how, who });
  }
  if (agentType === "model") {
    const model = agentId.startsWith("change:") ? "" : agentId.replace(/^mux:/, "");
    const base = BY_ASSISTANT.has(activity) ? how : t("graph.prov.howByAssistant", { how });
    return model ? t("graph.prov.withModel", { text: base, model }) : base;
  }
  return t("graph.prov.howRule", { how, rule: t("graph.prov.ruleLower", { name: agentId.replace(/^rule:/, "").replace(/_/g, " ") }) });
}

const WHEN_PATTERNS: Record<Locale, Record<"year" | "month" | "minute" | "day", string>> = {
  en: { year: "yyyy", month: "MMMM yyyy", minute: "d MMMM yyyy, HH:mm", day: "d MMMM yyyy" },
  da: { year: "yyyy", month: "MMMM yyyy", minute: "d. MMMM yyyy 'kl.' HH:mm", day: "d. MMMM yyyy" },
};

/** A node's place in time, at the precision we know it, in the reader's language. */
export function formatWhen(start: Date | string | null, end: Date | string | null, precision: string | null, locale: Locale = "en"): string {
  if (!start) return "";
  const p = WHEN_PATTERNS[locale] ?? WHEN_PATTERNS.en;
  const pattern = precision === "year" ? p.year : precision === "month" ? p.month : precision === "minute" ? p.minute : p.day;
  const opts = { locale: dateLocale(locale) };
  const s = format(new Date(start), pattern, opts);
  if (!end) return s;
  const e = format(new Date(end), pattern, opts);
  if (precision === "minute" && format(new Date(start), "yyyy-MM-dd") === format(new Date(end), "yyyy-MM-dd")) {
    return `${s}–${format(new Date(end), "HH:mm")}`;
  }
  return e === s ? s : `${s} – ${e}`;
}

/** "4 Nov 2026" / "4. nov. 2026". */
export function formatDate(d: Date | string, locale: Locale = "en"): string {
  return format(new Date(d), locale === "da" ? "d. MMM yyyy" : "d MMM yyyy", { locale: dateLocale(locale) });
}

/** "Mon 16 Nov 2026" for a single day, as shown in headers. */
export function formatDay(d: Date | string, locale: Locale = "en"): string {
  return format(new Date(d), locale === "da" ? "EEE d. MMM yyyy" : "EEE d MMM yyyy", { locale: dateLocale(locale) });
}
