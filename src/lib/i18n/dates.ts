/**
 * Dates in the reader's language and time zone. Pure, so both server and client components can use it.
 * Stored times are UTC; these format them for a person (Intl with an explicit time zone, so the server's own zone
 * never leaks into what people see). For date-fns helpers (distance, relative words) use `dateLocale(locale)`.
 */
import { da, enGB } from "date-fns/locale";
import { formatDistanceStrict, type Locale as DateFnsLocale } from "date-fns";
import { DEFAULT_LOCALE, INTL_TAG, type Locale } from "./core";

export const DEFAULT_TIME_ZONE = "Europe/Copenhagen";

/** The date-fns locale for a language: en-GB for English (day before month, 24-hour clock), da for Danish. */
export function dateLocale(locale: Locale = DEFAULT_LOCALE): DateFnsLocale {
  return locale === "da" ? da : enGB;
}

/** Whether `tz` is an IANA time zone this runtime knows ("Europe/Copenhagen"). */
export function isTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Time zones to offer, with the common ones for this household first. */
export function timeZoneChoices(): string[] {
  const first = ["Europe/Copenhagen", "Europe/London", "Europe/Stockholm", "Europe/Oslo", "Europe/Berlin", "UTC"];
  let all: string[] = [];
  try { all = Intl.supportedValuesOf("timeZone"); } catch { all = []; }
  return [...first, ...all.filter((z) => !first.includes(z))];
}

export type DateStyle = "date" | "dateLong" | "dateTime" | "time" | "weekday" | "monthYear";

type Opts = { locale?: Locale; timeZone?: string; now?: Date };

function parts(d: Date, tz: string) {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  return f.format(d); // YYYY-MM-DD in that zone
}

/** Same calendar year in the reader's zone. */
function sameYear(a: Date, b: Date, tz: string) {
  return parts(a, tz).slice(0, 4) === parts(b, tz).slice(0, 4);
}

/**
 * "3 Nov" / "3. nov." (the year is added when it isn't this year), "Tuesday 3 November 2026", "3 Nov, 14:05",
 * "14:05", "Tue 3 Nov", "November 2026".
 */
export function formatDate(input: Date | string | number, style: DateStyle = "date", opts: Opts = {}): string {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return "";
  const locale = opts.locale ?? DEFAULT_LOCALE;
  const timeZone = opts.timeZone && isTimeZone(opts.timeZone) ? opts.timeZone : DEFAULT_TIME_ZONE;
  const tag = INTL_TAG[locale];
  const thisYear = sameYear(d, opts.now ?? new Date(), timeZone);
  const year = thisYear ? {} : { year: "numeric" as const };
  const f = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(tag, { timeZone, ...o }).format(d);
  switch (style) {
    case "date": return f({ day: "numeric", month: "short", ...year });
    case "dateLong": return f({ weekday: "long", day: "numeric", month: "long", year: "numeric" });
    case "dateTime": return `${f({ day: "numeric", month: "short", ...year })}, ${f({ hour: "2-digit", minute: "2-digit", hourCycle: "h23" })}`;
    case "time": return f({ hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    // Composed rather than one format: Node's and the browser's ICU disagree on the comma ("Tue, 3 Nov" / "Tue 3 Nov"),
    // which breaks hydration.
    case "weekday": return `${f({ weekday: "short" })} ${f({ day: "numeric", month: "short", ...year })}`;
    case "monthYear": return f({ month: "long", year: "numeric" });
  }
}

/** Calendar day key (YYYY-MM-DD) in the reader's zone: for grouping lists by day. */
export function dayKey(input: Date | string, timeZone: string = DEFAULT_TIME_ZONE): string {
  return parts(input instanceof Date ? input : new Date(input), isTimeZone(timeZone) ? timeZone : DEFAULT_TIME_ZONE);
}

/** "3 minutes ago" / "3 minutter siden"; under a minute is "just now" / "lige nu". */
export function formatAgo(input: Date | string | number, locale: Locale = DEFAULT_LOCALE, now: Date = new Date()): string {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return "";
  if (Math.abs(now.getTime() - d.getTime()) < 60_000) return locale === "da" ? "lige nu" : "just now";
  return formatDistanceStrict(d, now, { addSuffix: true, locale: dateLocale(locale) });
}
