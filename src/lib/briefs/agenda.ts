/** Merges events and reminders into the day-bucketed "Coming up" list (pure; used by the client list). */
import { calendarDayDiff, groupByBucket, type BucketGroup } from "./dates";

export type AgendaEvent = { id: string; startAt: string; endAt: string | null };
export type AgendaReminder = { id: string; dueAt: string; done: boolean };

export type AgendaItem<E, R> =
  | { kind: "event"; key: string; at: Date; event: E }
  | { kind: "reminder"; key: string; at: Date; reminder: R };

/**
 * Events from today on (an event still running counts as today), and reminders. Done reminders stay in place so a
 * check-off can be undone; overdue open reminders collect under "Overdue". Events never show as overdue.
 */
export function buildAgenda<E extends AgendaEvent, R extends AgendaReminder>(events: E[], reminders: R[], now: Date, tz: string): BucketGroup<AgendaItem<E, R>>[] {
  const items: AgendaItem<E, R>[] = [];
  for (const e of events) {
    const start = new Date(e.startAt);
    const end = e.endAt ? new Date(e.endAt) : start;
    if (calendarDayDiff(end, now, tz) < 0) continue;
    // A multi-day event that started earlier is listed under today.
    const at = calendarDayDiff(start, now, tz) < 0 ? now : start;
    items.push({ kind: "event", key: `e:${e.id}`, at, event: e });
  }
  for (const r of reminders) {
    const due = new Date(r.dueAt);
    // A reminder ticked off while overdue stays where it was until reload, under today.
    const at = r.done && calendarDayDiff(due, now, tz) < 0 ? now : due;
    items.push({ kind: "reminder", key: `r:${r.id}`, at, reminder: r });
  }
  return groupByBucket(items, (i) => i.at, now, tz);
}
