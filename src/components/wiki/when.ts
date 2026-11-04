/**
 * How the wiki says when something happened: plain words in the reader's language and time zone, never an ISO
 * string. Pure (no React), so server pages, client components and tests share it. Build one with `makeWhen` from
 * `getT`/`getPrefs` on the server or `useT`/`useLocale`/`useTimeZone` on the client.
 */
import { dayKey, formatDate } from "@/lib/i18n/dates";
import type { Locale, TFn } from "@/lib/i18n/core";

export type RecencyGroup = "today" | "week" | "month" | "year" | "older";
export const RECENCY_GROUPS: RecencyGroup[] = ["today", "week", "month", "year", "older"];

/** Whole calendar days from `d` to `now`, counted in `timeZone` (0 = same day, 1 = yesterday). */
export function calendarDaysAgo(d: Date, now: Date, timeZone: string): number {
  const toUtc = (k: string) => { const [y, m, day] = k.split("-").map(Number); return Date.UTC(y, m - 1, day); };
  return Math.round((toUtc(dayKey(now, timeZone)) - toUtc(dayKey(d, timeZone))) / 86_400_000);
}

export type When = {
  /** For lists: "14:02", "Yesterday", "Tue 3 Nov", "3 Nov 2025". */
  short: (d: Date) => string;
  /** For a sentence: "today at 14:02", "yesterday at 20:56", "on Tuesday at 09:10", "on 3 Nov". */
  sentence: (d: Date) => string;
  /** The full moment, for a tooltip. */
  full: (d: Date) => string;
  /** The clock time alone. */
  time: (d: Date) => string;
  /** Which recency bucket a page falls into, for grouping the index. */
  group: (d: Date) => RecencyGroup;
  /** The group's heading. */
  groupLabel: (g: RecencyGroup) => string;
};

export function makeWhen({ t, locale, timeZone, now }: { t: TFn; locale: Locale; timeZone: string; now?: () => Date }): When {
  const at = now ?? (() => new Date());
  const time = (d: Date) => formatDate(d, "time", { locale, timeZone });
  const weekdayLong = (d: Date) => new Intl.DateTimeFormat(locale === "da" ? "da-DK" : "en-GB", { timeZone, weekday: "long" }).format(d);
  const days = (d: Date) => calendarDaysAgo(d, at(), timeZone);
  return {
    time,
    short: (d) => {
      const n = days(d);
      if (n === 0) return time(d);
      if (n === 1) return t("wiki.when.yesterday");
      return formatDate(d, "weekday", { locale, timeZone, now: at() });
    },
    sentence: (d) => {
      const n = days(d);
      if (n === 0) return t("wiki.when.todayAt", { time: time(d) });
      if (n === 1) return t("wiki.when.yesterdayAt", { time: time(d) });
      if (n > 1 && n < 7) return t("wiki.when.weekdayAt", { day: weekdayLong(d), time: time(d) });
      return t("wiki.when.on", { date: formatDate(d, "date", { locale, timeZone, now: at() }) });
    },
    full: (d) => t("wiki.when.full", { date: formatDate(d, "dateLong", { locale, timeZone }), time: time(d) }),
    group: (d) => {
      const n = days(d);
      if (n <= 0) return "today";
      if (n < 7) return "week";
      if (n < 31) return "month";
      if (dayKey(d, timeZone).slice(0, 4) === dayKey(at(), timeZone).slice(0, 4)) return "year";
      return "older";
    },
    groupLabel: (g) => t(`wiki.when.groups.${g}`),
  };
}
