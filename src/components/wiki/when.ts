/** How the wiki says when something happened. Plain words, date-fns, never an ISO string. */
import { differenceInCalendarDays, format, isThisYear, isToday, isYesterday } from "date-fns";

/** Short, for lists: "14:02", "Yesterday", "Tue 3 Nov", "3 Nov 2025". */
export function shortWhen(d: Date): string {
  if (isToday(d)) return format(d, "HH:mm");
  if (isYesterday(d)) return "Yesterday";
  return format(d, isThisYear(d) ? "EEE d MMM" : "d MMM yyyy");
}

/** For a sentence: "today at 14:02", "yesterday at 20:56", "on Tuesday at 09:10", "on 3 Nov", "on 3 Nov 2025". */
export function sentenceWhen(d: Date): string {
  if (isToday(d)) return `today at ${format(d, "HH:mm")}`;
  if (isYesterday(d)) return `yesterday at ${format(d, "HH:mm")}`;
  if (differenceInCalendarDays(new Date(), d) < 7) return `on ${format(d, "EEEE 'at' HH:mm")}`;
  return isThisYear(d) ? `on ${format(d, "EEE d MMM")}` : `on ${format(d, "d MMM yyyy")}`;
}

/** The full moment, for a tooltip. */
export function fullWhen(d: Date): string {
  return format(d, "EEEE d MMMM yyyy 'at' HH:mm");
}

export type RecencyGroup = "Today" | "This week" | "This month" | "Earlier this year" | "Older";

/** Which recency bucket a page falls into, for grouping the index. */
export function recencyGroup(d: Date, now = new Date()): RecencyGroup {
  const days = differenceInCalendarDays(now, d);
  if (days <= 0) return "Today";
  if (days < 7) return "This week";
  if (days < 31) return "This month";
  if (d.getFullYear() === now.getFullYear()) return "Earlier this year";
  return "Older";
}
