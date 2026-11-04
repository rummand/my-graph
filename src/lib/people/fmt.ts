/**
 * Date and span words for the people pages in the reader's language and time zone (pure; the client hook is
 * `useFmt` in src/components/people/format.tsx).
 */
import { differenceInCalendarDays } from "date-fns";
import { INTL_TAG, type Locale, type TFn } from "@/lib/i18n/core";
import { formatAgo, formatDate } from "@/lib/i18n/dates";

export type Fmt = {
  t: TFn;
  locale: Locale;
  /** "today", "yesterday", "5 days ago", "3 months ago". */
  ago: (iso: string | null | undefined, now?: Date) => string;
  /** "Mon 16 Nov" (the year is added when it isn't this year). */
  shortDate: (iso: string) => string;
  /** "16 Nov" / "16 Nov 2025": compact, for date columns. */
  compactDate: (iso: string) => string;
  /** "75 days", "4 weeks", "3 months". */
  daysWords: (n: number) => string;
  /** "Sun 8 Nov" for a calendar date (YYYY-MM-DD). */
  dayLabel: (ymd: string) => string;
  /** "today", "tomorrow", "in 4 days". */
  inDays: (n: number) => string;
  /** Short month for chart axes: "Nov", "Jan 2026". */
  month: (d: Date, withYear: boolean) => string;
  /** Full date and time for tooltips. */
  full: (iso: string) => string;
};

export function makeFmt(t: TFn, locale: Locale, timeZone: string): Fmt {
  const opts = { locale, timeZone };
  return {
    t, locale,
    ago: (iso, now = new Date()) => {
      if (!iso) return t("people.when.never");
      const d = new Date(iso);
      const days = differenceInCalendarDays(now, d);
      if (days <= 0) return t("people.when.today");
      if (days === 1) return t("people.when.yesterday");
      if (days < 14) return t("people.when.daysAgo", { count: days });
      return formatAgo(d, locale, now);
    },
    shortDate: (iso) => formatDate(iso, "weekday", opts),
    compactDate: (iso) => formatDate(iso, "date", opts),
    daysWords: (n) => n < 21 ? t("people.span.days", { count: n }) : n < 60 ? t("people.span.weeks", { count: Math.round(n / 7) }) : t("people.span.months", { count: Math.round(n / 30) }),
    // A calendar date: format it as that day, whatever the zone.
    dayLabel: (ymd) => formatDate(`${ymd}T12:00:00Z`, "weekday", { locale, timeZone: "UTC" }),
    inDays: (n) => n === 0 ? t("people.when.today") : n === 1 ? t("people.when.tomorrow") : t("people.when.inDays", { count: n }),
    month: (d, withYear) => new Intl.DateTimeFormat(INTL_TAG[locale], { timeZone, month: "short", ...(withYear ? { year: "numeric" } : {}) }).format(d).replace(/\.$/, ""),
    full: (iso) => formatDate(iso, "dateLong", opts) + ", " + formatDate(iso, "time", opts),
  };
}

