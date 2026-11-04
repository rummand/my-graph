/**
 * Pure, translated wording for automations: "Today 18:00", "Sundays at 18:00", "Every hour, weekdays 07:00–20:00".
 * No React, so the tests can cover it. `t` is the reader's translator, `fmt` formats a date in their language and zone.
 */
import { INTL_TAG, type Locale, type TFn } from "@/lib/i18n/core";
import { dayKey, type DateStyle } from "@/lib/i18n/dates";
import type { ParsedTrigger } from "@/lib/automations/schedule";

export type Fmt = (d: Date | string | number, style?: DateStyle) => string;
export type Copy = { t: TFn; fmt: Fmt; timeZone: string; locale?: Locale; now?: Date };

/**
 * "Sun 8 Nov" / "søn. 8. nov." built from parts, so the server and the browser (which may ship different ICU data and
 * punctuation, "Sun, 8 Nov") render the same text and hydration matches.
 */
export function shortDay(d: Date, locale: Locale, timeZone: string, now = new Date()): string {
  const parts = new Intl.DateTimeFormat(INTL_TAG[locale], { timeZone, weekday: "short", day: "numeric", month: "short", year: "numeric" }).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const sameYear = get("year") === new Intl.DateTimeFormat("en", { timeZone, year: "numeric" }).format(now);
  const wd = get("weekday").replace(/,$/, ""), day = get("day"), mon = get("month").replace(/,$/, "");
  const core = locale === "da" ? `${wd} ${day}. ${mon}` : `${wd} ${day} ${mon}`;
  return sameYear ? core : `${core} ${get("year")}`;
}

const WEEKDAYS = "1,2,3,4,5";

/** "Wednesday 4 November" / "onsdag 4. november" (year added when it isn't this year), built from parts like shortDay. */
export function longDay(d: Date, locale: Locale, timeZone: string, now = new Date()): string {
  const parts = new Intl.DateTimeFormat(INTL_TAG[locale], { timeZone, weekday: "long", day: "numeric", month: "long", year: "numeric" }).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const sameYear = get("year") === new Intl.DateTimeFormat("en", { timeZone, year: "numeric" }).format(now);
  const core = locale === "da" ? `${get("weekday")} ${get("day")}. ${get("month")}` : `${get("weekday")} ${get("day")} ${get("month")}`;
  return sameYear ? core : `${core} ${get("year")}`;
}

/** "Today 18:00", "Tomorrow 07:00", "Yesterday 21:15", "Sun 8 Nov, 18:00". `inline` lower-cases the first word. */
export function whenText(c: Copy, iso: string | Date | null | undefined, inline = false): string {
  if (!iso) return "";
  const d = typeof iso === "string" ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return "";
  const now = c.now ?? new Date();
  const time = c.fmt(d, "time");
  const day = dayKey(d, c.timeZone);
  const rel = (offset: number) => dayKey(new Date(now.getTime() + offset * 864e5), c.timeZone);
  const suffix = inline ? "Inline" : "";
  if (day === rel(0)) return c.t(`automations.when.today${suffix}`, { time });
  if (day === rel(1)) return c.t(`automations.when.tomorrow${suffix}`, { time });
  if (day === rel(-1)) return c.t(`automations.when.yesterday${suffix}`, { time });
  return c.t("automations.when.dated", { date: shortDay(d, c.locale ?? "en", c.timeZone, now), time });
}

/** "just now", "12 min ago", or `whenText` for anything older than an hour. */
export function agoText(c: Copy, iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  const m = Math.floor(((c.now ?? new Date()).getTime() - d.getTime()) / 60_000);
  if (m < 1) return c.t("automations.when.justNow");
  if (m < 60) return c.t("automations.when.minAgo", { count: m });
  return whenText(c, d);
}

/** "Every hour", "Every 2 hours", "Every 15 minutes", "Once a day". */
export function everyText(t: TFn, minutes: number): string {
  if (minutes === 1440) return t("automations.trigger.onceADay");
  if (minutes % 60 === 0) return minutes === 60 ? t("automations.trigger.everyHour") : t("automations.trigger.everyHours", { count: minutes / 60 });
  return t("automations.trigger.everyMinutes", { count: minutes });
}

/** "Every day", "Weekdays", "Weekends", "Sundays", "Mondays and Thursdays" (plural) or "Monday" (singular). */
export function daysText(t: TFn, days: number[], plural: boolean): string {
  const s = [...new Set(days)].sort();
  if (s.length === 7) return t("automations.days.everyDay");
  if (s.join() === WEEKDAYS) return t("automations.days.weekdays");
  if (s.join() === "0,6") return t("automations.days.weekends");
  // Monday first, as the week reads in Denmark.
  const ordered = [...s.filter((x) => x !== 0), ...s.filter((x) => x === 0)];
  const names = ordered.map((x) => t(`automations.days.${plural ? "plural" : "long"}.d${x}`));
  if (names.length === 1) return names[0];
  return t("automations.days.and", { list: names.slice(0, -1).join(", "), last: names[names.length - 1] });
}

const lowerFirst = (s: string) => (s ? s[0].toLowerCase() + s.slice(1) : s);

/** One line on when an automation or check-in runs. */
export function triggerText(c: Copy, p: ParsedTrigger): string {
  const { t } = c;
  if (p.trigger === "schedule") {
    if (p.config.date) return t("automations.trigger.once", { date: c.fmt(`${p.config.date}T12:00:00Z`, "date"), time: p.config.time });
    return t("automations.trigger.schedule", { days: daysText(t, p.config.days, true), time: p.config.time });
  }
  if (p.trigger === "heartbeat") {
    return t("automations.trigger.heartbeat", {
      every: everyText(t, p.config.everyMinutes), days: lowerFirst(daysText(t, p.config.days, false)), from: p.config.from, to: p.config.to,
    });
  }
  return t("automations.trigger.condition", { every: everyText(t, p.config.everyMinutes), check: lowerFirst(p.config.check) });
}
