/** Date formatting for prompts (pure). The household lives in Denmark unless APP_TIME_ZONE says otherwise. */
export const DEFAULT_TZ = "Europe/Copenhagen";

export function timeZone(): string {
  const tz = typeof process !== "undefined" ? process.env.APP_TIME_ZONE : undefined;
  if (tz) {
    try { new Intl.DateTimeFormat("en-GB", { timeZone: tz }); return tz; } catch { /* invalid */ }
  }
  return DEFAULT_TZ;
}

/** "Tuesday 3 November 2026" */
export function longDay(d: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(d);
}

/** "Thu 5 Nov 2026, 08:30" or "Thu 5 Nov 2026" when no time of day is known. */
export function whenLabel(d: Date, tz: string, precision: "minute" | "day" | "month" | "year" | null = "minute"): string {
  if (precision === "year") return new Intl.DateTimeFormat("en-GB", { timeZone: tz, year: "numeric" }).format(d);
  if (precision === "month") return new Intl.DateTimeFormat("en-GB", { timeZone: tz, month: "long", year: "numeric" }).format(d);
  const day = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short", year: "numeric" }).format(d);
  if (precision === "day") return day;
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
  return time === "00:00" ? day : `${day}, ${time}`;
}
