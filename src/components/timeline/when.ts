/**
 * Timeline dates in the reader's language (date-fns with en-GB or da). Pure: the server page and the client
 * components both use it. English: "3 March 2026", "Tue 3 Nov"; Danish: "3. marts 2026", "tirs. 3. nov.".
 * Precision is honoured: a month-only date reads "March 2026", a year-only date "2026".
 */
import { format, type Locale as DateFnsLocale } from "date-fns";
import { da, enGB } from "date-fns/locale";
import type { Locale } from "@/lib/i18n/core";
import { calendarDay, effectivePrecision, type TickSpec } from "@/lib/timeline/pure";
import type { TimelineItem } from "@/lib/timeline/types";

type Precision = TimelineItem["precision"];

const PATTERNS = {
  en: {
    year: "yyyy", month: "MMMM yyyy", monthOnly: "MMMM", day: "d MMMM yyyy", dayMonth: "d MMMM", dayOnly: "d",
    minute: "d MMMM yyyy, HH:mm", time: "HH:mm", short: "EEE d MMM", long: "EEEE d MMMM", shortDay: "d MMM", shortDayYear: "d MMM yyyy",
    monthShort: "MMM", monthShortYear: "MMM yyyy", weekdayShort: "EEE", weekdayDay: "EEE d", stamp: "d MMM yyyy, HH:mm",
  },
  da: {
    year: "yyyy", month: "MMMM yyyy", monthOnly: "MMMM", day: "d. MMMM yyyy", dayMonth: "d. MMMM", dayOnly: "d.",
    minute: "d. MMMM yyyy 'kl.' HH:mm", time: "HH:mm", short: "EEE d. MMM", long: "EEEE d. MMMM", shortDay: "d. MMM", shortDayYear: "d. MMM yyyy",
    monthShort: "MMM", monthShortYear: "MMM yyyy", weekdayShort: "EEE", weekdayDay: "EEE d.", stamp: "d. MMM yyyy 'kl.' HH:mm",
  },
} as const;

type Pattern = keyof (typeof PATTERNS)["en"];

const toDate = (d: Date | string | number) => (d instanceof Date ? d : new Date(d));
/** Danish month and weekday names are lower case; a heading or the start of a line wants a capital. */
export const capitalize = (s: string) => (s ? s[0].toLocaleUpperCase() + s.slice(1) : s);

export type When = {
  locale: Locale;
  dateLocale: DateFnsLocale;
  /** One pattern by name, in this language. */
  fmt: (d: Date | string | number, pattern: Pattern) => string;
  /** "2021", "March 2021", "3 March 2021", "3 March 2021, 14:30", and ranges collapsing what both ends share. */
  when: (start: Date | string, end: Date | string | null, precision: Precision) => string;
  /** Axis tick label; the first tick of a bigger unit carries that unit. */
  tick: (d: Date, spec: TickSpec) => string;
  /** The axis's upper tier: the day, month or year a stretch of ticks belongs to. */
  upper: (d: Date, unit: TickSpec["unit"]) => string;
  /** The window on screen: "3 Nov – 1 Dec", "Nov – Mar 2027". */
  range: (a: number, b: number) => string;
  /** Month heading for the phone list: "March 2021" / "Marts 2021". */
  monthHeading: (d: Date) => string;
};

export function makeWhen(locale: Locale): When {
  const P = PATTERNS[locale] ?? PATTERNS.en;
  const dl = locale === "da" ? da : enGB;
  const fmt = (d: Date | string | number, pattern: Pattern) => format(toDate(d), P[pattern], { locale: dl });

  const when: When["when"] = (start, end, precision) => {
    const p = effectivePrecision(start, precision);
    const a = p === "minute" ? toDate(start) : calendarDay(start);
    const b = end ? (p === "minute" ? toDate(end) : calendarDay(end)) : null;
    const one = (d: Date) => fmt(d, p);
    if (!b || b.getTime() <= a.getTime() || one(a) === one(b)) return one(a);
    const sameYear = a.getFullYear() === b.getFullYear();
    const sameMonth = sameYear && a.getMonth() === b.getMonth();
    const sameDay = sameMonth && a.getDate() === b.getDate();
    switch (p) {
      case "year": return `${fmt(a, "year")} – ${fmt(b, "year")}`;
      case "month": return sameYear ? `${fmt(a, "monthOnly")} – ${fmt(b, "month")}` : `${fmt(a, "month")} – ${fmt(b, "month")}`;
      case "day":
        if (sameMonth) return `${fmt(a, "dayOnly")} – ${fmt(b, "day")}`;
        if (sameYear) return `${fmt(a, "dayMonth")} – ${fmt(b, "day")}`;
        return `${fmt(a, "day")} – ${fmt(b, "day")}`;
      default:
        if (sameDay) return `${fmt(a, "minute")} – ${fmt(b, "time")}`;
        return `${fmt(a, "minute")} – ${fmt(b, "minute")}`;
    }
  };

  const tick: When["tick"] = (d, spec) => {
    switch (spec.unit) {
      case "year": return fmt(d, "year");
      case "month": return d.getMonth() === 0 ? fmt(d, "year") : fmt(d, "monthShort");
      case "week": return fmt(d, "shortDay");
      case "day": return d.getDate() === 1 ? fmt(d, "shortDay") : spec.step === 1 ? fmt(d, "weekdayDay") : fmt(d, "dayOnly");
      case "hour": return d.getHours() === 0 ? fmt(d, "short") : fmt(d, "time");
    }
  };

  const upper: When["upper"] = (d, unit) => capitalize(unit === "hour" ? fmt(d, "long") : unit === "month" ? fmt(d, "year") : fmt(d, "month"));

  const range: When["range"] = (a, b) => {
    const da0 = new Date(a), db0 = new Date(b);
    const DAY = 86_400_000;
    if (b - a > 120 * DAY) {
      return da0.getFullYear() === db0.getFullYear()
        ? capitalize(`${fmt(da0, "monthShort")} – ${fmt(db0, "monthShortYear")}`)
        : capitalize(`${fmt(da0, "monthShortYear")} – ${fmt(db0, "monthShortYear")}`);
    }
    if (da0.getFullYear() !== db0.getFullYear()) return `${fmt(da0, "shortDayYear")} – ${fmt(db0, "shortDayYear")}`;
    return `${fmt(da0, "shortDay")} – ${fmt(db0, "shortDay")}`;
  };

  return { locale, dateLocale: dl, fmt, when, tick, upper, range, monthHeading: (d) => capitalize(fmt(d, "month")) };
}

/** The "Due", "Added", "Dated" word that goes before an item's date, as a message key (or null for events). */
export function datePrefixKey(kind: TimelineItem["kind"]): string | null {
  return kind === "reminder" ? "timeline.when.due" : kind === "source" ? "timeline.when.added" : kind === "document" ? "timeline.when.dated" : null;
}
