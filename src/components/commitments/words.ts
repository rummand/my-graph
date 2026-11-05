/**
 * Words and marks for commitments shared by the ledger, Today, person pages and the node panel (no hooks, no server
 * imports: server and client components can both use them).
 */
import {
  Banknote, CalendarClock, CircleDot, Flag, Package, PenLine, RefreshCw, Reply, Undo2, type LucideIcon,
} from "lucide-react";
import type { TFn } from "@/lib/i18n/core";
import { formatDate } from "@/lib/i18n/dates";
import type { Locale } from "@/lib/i18n/core";
import { daysUntil, formatAmount, parseRRule, type CommitmentView } from "@/lib/commitments/pure";
import type { CommitmentKind, CommitmentUrgency } from "@/lib/commitments/types";

export const KIND_ICON: Record<CommitmentKind, LucideIcon> = {
  reply: Reply, payment: Banknote, renewal: RefreshCw, notice: Flag, appointment: CalendarClock, form: PenLine,
  deliver: Package, return: Undo2, other: CircleDot,
};

/** "Fri 14 Nov" and "in 9 days" / "Today" / "2 days ago" (null when there is no date). */
export function dueWords(c: Pick<CommitmentView, "props">, t: TFn, locale: Locale, tz: string, now: Date): { date: string; rel: string; days: number } | null {
  const due = c.props.dueAt;
  if (!due) return null;
  const days = daysUntil(due, now, tz);
  const date = formatDate(due, "weekday", { locale, timeZone: tz, now });
  const rel = days === 0 ? t("commitments.due.today") : days === 1 ? t("commitments.due.tomorrow") : days === -1 ? t("commitments.due.yesterday")
    : days > 0 ? t("commitments.due.inDays", { count: days }) : t("commitments.due.daysAgo", { count: -days });
  return { date: c.props.dueKind === "approx" ? t("commitments.due.around", { date }) : date, rel, days };
}

export function recurrenceWords(rrule: string | null | undefined, t: TFn): string | null {
  const r = parseRRule(rrule);
  if (!r) return rrule ? t("commitments.recurrence.other") : null;
  if (r.interval !== 1) return t("commitments.recurrence.other");
  return t(`commitments.recurrence.${r.freq.toLowerCase()}`);
}

/** The short "with Vejle Kommune, 1,250 kr" line under a commitment's sentence (no "A · B · C" strings). */
export function detailLine(c: CommitmentView, t: TFn, locale: Locale): string {
  const party = c.counterparty[0]?.label;
  const bits = [
    party ? (c.props.direction === "owed" ? t("commitments.row.owedBy", { name: party }) : t("commitments.row.with", { name: party })) : null,
    formatAmount(c.props.amount, locale),
  ].filter(Boolean);
  return bits.join(", ");
}

/** Tone of the urgency mark: brick for overdue, amber for at risk, ink otherwise. */
export function urgencyTone(u: CommitmentUrgency | null): "danger" | "warn" | "plain" {
  return u === "overdue" ? "danger" : u === "at_risk" ? "warn" : "plain";
}

/** Sensible snooze times (08:00 in the household's zone), only those before it is due. */
export function snoozeChoices(dueAt: string | null, now: Date, tz: string): { key: "tomorrow" | "in3" | "nextWeek"; at: Date }[] {
  const at = (addDays: number) => {
    const d = new Date(now.getTime() + addDays * 86_400_000);
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
    // 08:00 local: find the UTC instant whose local time in tz is 08:00 on that day.
    const guess = new Date(`${day}T08:00:00Z`);
    const local = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hourCycle: "h23" }).format(guess);
    return new Date(guess.getTime() - (Number(local) - 8) * 3_600_000);
  };
  const weekday = Math.max(0, ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(now)));
  const toMonday = ((8 - weekday) % 7) || 7;
  const all = [{ key: "tomorrow" as const, at: at(1) }, { key: "in3" as const, at: at(3) }, { key: "nextWeek" as const, at: at(toMonday) }];
  const due = dueAt ? Date.parse(dueAt) : Number.POSITIVE_INFINITY;
  const seen = new Set<number>();
  return all.filter((c) => c.at.getTime() > now.getTime() && c.at.getTime() < due && !seen.has(c.at.getTime()) && seen.add(c.at.getTime()));
}
