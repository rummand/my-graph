/**
 * The morning line (pure, a template — no model): one sentence in the reader's language for Today and notifications.
 *
 *   "3 things this week, 1 at risk: give notice on the car insurance (last day Tue)."
 *   "3 ting i denne uge, 1 i fare: opsig bilforsikringen (sidste dag tirs.)."
 *
 * Overdue comes first when there is any; the one thing named is the most pressing (overdue, else at risk, else the
 * next due). An optional model polish exists on the server (`polishSummary`), off unless COMMITMENTS_SUMMARY_POLISH=1.
 */
import { DEFAULT_TZ, daysUntil } from "../pure";
import type { CommitmentKind, CommitmentUrgency } from "../types";

export type SummaryItem = { label: string; dueAt: string | null; urgency: CommitmentUrgency | null; kind?: CommitmentKind };
export type SummaryLocale = "en" | "da";

/** First words that read fine in lower case mid-sentence ("Pay …" → "pay …"); anything else (a name) keeps its case. */
const LOWERABLE = /^(pay|give|reply|answer|renew|send|return|book|sign|fill|submit|bring|hand|cancel|register|apply|call|collect|pick|buy|order|check|the|a|an|betal|giv|svar|besvar|forny|send|aflever|returner|opsig|underskriv|udfyld|indsend|medbring|tilmeld|ansøg|ring|hent|køb|bestil|tjek|husk|book)\b/i;

function inSentence(label: string): string {
  const l = label.trim().replace(/[.!]+$/, "");
  return LOWERABLE.test(l) ? l.charAt(0).toLowerCase() + l.slice(1) : l;
}

function dayWord(dueAt: string, now: Date, locale: SummaryLocale, tz: string): string {
  const d = daysUntil(dueAt, now, tz);
  if (d === 0) return locale === "da" ? "i dag" : "today";
  if (d === 1) return locale === "da" ? "i morgen" : "tomorrow";
  if (d === -1) return locale === "da" ? "i går" : "yesterday";
  const opts: Intl.DateTimeFormatOptions = d > 0 && d < 7 ? { weekday: "short", timeZone: tz } : { day: "numeric", month: "short", timeZone: tz };
  return new Intl.DateTimeFormat(locale === "da" ? "da-DK" : "en-GB", opts).format(new Date(dueAt));
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The sentence. `items` are open commitments with their urgency (done/cancelled ones are ignored). */
export function morningSummary(items: SummaryItem[], locale: SummaryLocale, now: Date, tz = DEFAULT_TZ): string {
  const open = items.filter((i) => i.urgency !== null);
  const overdue = open.filter((i) => i.urgency === "overdue");
  const atRisk = open.filter((i) => i.urgency === "at_risk");
  // "This week": everything due in the next seven days, whatever its group (at risk ones included).
  const week = open.filter((i) => i.dueAt && i.urgency !== "overdue" && daysUntil(i.dueAt, now, tz) <= 6);
  const da = locale === "da";
  if (!overdue.length && !week.length) {
    const later = open.filter((i) => i.urgency === "later" || i.urgency === "undated").length;
    if (!later) return da ? "Ingen frister lige nu." : "Nothing due right now.";
    return da ? `Intet med frist i denne uge (${count(later, "ting", "ting")} senere).` : `Nothing due this week (${count(later, "thing", "things")} later).`;
  }
  const parts: string[] = [];
  if (overdue.length) parts.push(da ? `${overdue.length} over fristen` : `${overdue.length} overdue`);
  if (week.length) parts.push(da ? `${count(week.length, "ting", "ting")} i denne uge` : `${count(week.length, "thing", "things")} this week`);
  if (atRisk.length) parts.push(da ? `${atRisk.length} i fare` : `${atRisk.length} at risk`);
  const byDue = (a: SummaryItem, b: SummaryItem) => Date.parse(a.dueAt ?? "9999") - Date.parse(b.dueAt ?? "9999");
  const pick = [...overdue].sort(byDue)[0] ?? [...atRisk].sort(byDue)[0] ?? [...week].sort(byDue)[0];
  const head = parts.join(", ");
  const sentence = head.charAt(0).toUpperCase() + head.slice(1);
  if (!pick?.dueAt) return `${sentence}.`;
  const when = dayWord(pick.dueAt, now, locale, tz);
  const tag = pick.urgency === "overdue"
    ? (da ? `fristen var ${when}` : `was due ${when}`)
    : pick.kind === "appointment" ? when : (da ? `sidste dag ${when}` : `last day ${when}`);
  const lead = !overdue.length && !atRisk.length ? (da ? "næste" : "next") : "";
  return `${sentence}${lead ? `; ${lead}` : ""}: ${inSentence(pick.label)} (${tag}).`;
}
