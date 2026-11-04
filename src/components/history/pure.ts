/** Pure helpers for the history and "who said so" panels. No React, no DB. */
import type { TFn } from "@/lib/i18n/core";

export type WhoSaidInput = {
  agentType: string; agentId: string; quote: string | null; sourceId: string | null; sourceTitle: string | null; createdAt: string | Date;
};
export type WhoSaidRow = {
  key: string; kind: "person" | "assistant" | "rule"; userId: string | null; count: number; last: Date;
  quote: string | null; sourceId: string | null; sourceTitle: string | null;
};

/**
 * Groups provenance records by who recorded them: each person on their own, every model run as "the assistant", every
 * rule as "built-in rules". Ordered by how much each said, then by how recently. The newest quote is kept.
 */
export function whoSaid(items: WhoSaidInput[]): WhoSaidRow[] {
  const rows = new Map<string, WhoSaidRow>();
  for (const p of items) {
    const kind: WhoSaidRow["kind"] = p.agentType === "user" ? "person" : p.agentType === "model" ? "assistant" : "rule";
    const key = kind === "person" ? `user:${p.agentId}` : kind;
    const at = new Date(p.createdAt);
    const row = rows.get(key);
    if (!row) {
      rows.set(key, { key, kind, userId: kind === "person" ? p.agentId : null, count: 1, last: at, quote: p.quote, sourceId: p.sourceId, sourceTitle: p.sourceTitle });
      continue;
    }
    row.count += 1;
    if (at > row.last) {
      row.last = at;
      if (p.quote) { row.quote = p.quote; row.sourceId = p.sourceId; row.sourceTitle = p.sourceTitle; }
    } else if (!row.quote && p.quote) {
      row.quote = p.quote; row.sourceId = p.sourceId; row.sourceTitle = p.sourceTitle;
    }
  }
  return [...rows.values()].sort((a, b) => b.count - a.count || b.last.getTime() - a.last.getTime());
}

const FIELDS = [
  "label", "summary", "aliases", "visibility", "sensitive", "kind", "startAt", "endAt", "status", "confidence", "relation",
  "type", "mergedInto", "timePrecision", "fromId", "toId", "validFrom", "validTo", "inverseLabel", "pluralLabel", "description", "category",
  "hidden", "options", "dataType",
];

/** A field as words: "the name", "the detail “email”". */
export function fieldText(field: string, t: TFn): string {
  if (field.startsWith("props.")) {
    // A built-in detail reads in the reader's language ("phone" → "Telefon"); a household's own stays as written.
    const words = field.slice(6).replace(/_/g, " ");
    const label = words.charAt(0).toUpperCase() + words.slice(1);
    return t("history.fieldProp", { key: /^[\p{L}\p{N} ()/-]+$/u.test(label) ? t(`people.attr.${label}`, undefined, words) : words });
  }
  return FIELDS.includes(field) ? t(`history.field.${field}`) : field.replace(/_/g, " ");
}
const KINDS = ["created", "updated", "retired", "restored", "merged", "added", "removed", "linked", "shared", "unlinked"];
const ACTORS = ["person", "assistant", "connector", "import", "system"];

/** A stored value as a person would say it: short, no JSON. */
export function valueText(v: unknown, t: TFn): string {
  if (v === null || v === undefined || v === "") return t("history.empty_value");
  if (typeof v === "boolean") return v ? t("history.yes") : t("history.no");
  if (Array.isArray(v)) return v.length ? v.map((x) => valueText(x, t)).join(", ") : t("history.empty_value");
  if (typeof v === "number") return String(v);
  if (typeof v === "string") {
    if (/^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(v)) return v.slice(0, 10);
    return v.length > 80 ? `${v.slice(0, 79)}…` : v;
  }
  return t("history.empty_value");
}

export type HistoryLineInput = { kind: string; field: string | null; fromValue: unknown; toValue: unknown; actorKind: string; actorName: string | null };

/** "Anna changed the name from Mormor to Inge" and similar, in the reader's language. */
export function historyLine(e: HistoryLineInput, t: TFn): { head: string; detail: string | null } {
  const who = e.actorName || (ACTORS.includes(e.actorKind) ? t(`history.actor.${e.actorKind}`) : e.actorKind);
  const field = e.field ? fieldText(e.field, t) : null;
  let head: string;
  if (e.kind === "merged" && e.field === "mergedInto") head = t("history.kind.mergedInto", { who });
  else if (e.kind === "updated") head = field ? t("history.kind.updated", { who, field }) : t("history.kind.updatedNoField", { who });
  else if ((e.kind === "added" || e.kind === "removed") && field) head = t(`history.kind.${e.kind}`, { who, field });
  else if (KINDS.includes(e.kind) && e.kind !== "added" && e.kind !== "removed") head = t(`history.kind.${e.kind}`, { who });
  else head = t("history.kind.other", { who, kind: e.kind });
  let detail: string | null = null;
  if (e.kind === "updated" && field && (e.field === "fromId" || e.field === "toId" || e.field === "mergedInto")) {
    detail = null;
  } else if (e.kind === "updated" && field) {
    const sensitive = e.field === "summary";
    detail = sensitive && typeof e.toValue === "string"
      ? t("history.toOnly", { to: valueText(e.toValue, t) })
      : t("history.fromTo", { from: valueText(e.fromValue, t), to: valueText(e.toValue, t) });
  }
  return { head, detail };
}
