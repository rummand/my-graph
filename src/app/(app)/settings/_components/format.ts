import { format, formatDistanceToNowStrict, isSameYear, isToday, isYesterday } from "date-fns";

/** "3 Nov", or "3 Nov 2025" when it isn't this year. */
export const fmtDate = (iso: string) => {
  const d = new Date(iso);
  return format(d, isSameYear(d, new Date()) ? "d MMM" : "d MMM yyyy");
};
export const fmtDateTime = (iso: string) => `${fmtDate(iso)}, ${format(new Date(iso), "HH:mm")}`;
export const fmtTime = (iso: string) => format(new Date(iso), "HH:mm");
export const fmtAgo = (iso: string) => {
  const ms = Date.now() - new Date(iso).getTime();
  return ms < 60_000 ? "just now" : `${formatDistanceToNowStrict(new Date(iso))} ago`;
};
/** A day heading: "Today", "Yesterday", "Mon 2 Nov". */
export const fmtDay = (iso: string) => {
  const d = new Date(iso);
  if (isToday(d)) return "Today";
  if (isYesterday(d)) return "Yesterday";
  return format(d, isSameYear(d, new Date()) ? "EEE d MMM" : "EEE d MMM yyyy");
};
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** "today", "yesterday" or "3 Nov": for phrases like "signed in today". */
export const fmtWhen = (iso: string) => {
  const d = new Date(iso);
  return isToday(d) ? "today" : isYesterday(d) ? "yesterday" : `on ${fmtDate(iso)}`;
};
