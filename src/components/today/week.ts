/**
 * Pure helpers for the family week strip and the reminder list on Today. No server imports, so they run in the
 * browser and in tests. All day maths goes through the household's time zone.
 */
import type { Locale } from "@/lib/i18n/core";
import { addDaysInZone, calendarDayDiff, formatShortDay, formatTime, monthShort, relativeDayLabel, startOfDayInZone, weekdayShort, zonedParts, zonedTimeToUtc } from "@/lib/briefs/dates";
import { todayT } from "@/lib/briefs/words";

export type Lane = {
  /** Stable key; for a child the user id, for the shared row "family". */
  key: string;
  /** Id that picks the person's colour (their person node id when they have one). Null for the shared row. */
  colorId: string | null;
  name: string;
  href: string | null;
  age: string | null;
  /** The person node reminders are attached to ("about"). */
  personNodeId: string | null;
  /** The user id events list in `children`. */
  userId: string | null;
};

export type StripEvent = { id: string; label: string; startAt: string; endAt: string | null; timePrecision: string | null; children: { userId: string }[] };
export type StripReminder = { id: string; title: string; dueAt: string; done: boolean; aboutNodeId: string | null; aboutLabel: string | null };

export type Day = { key: string; date: Date; index: number; weekday: string; dayOfMonth: number; isToday: boolean; isWeekend: boolean };

export type StripItem = {
  kind: "event" | "reminder";
  id: string;
  label: string;
  /** 0-based column in the visible week, and how many columns it covers. */
  col: number;
  span: number;
  /** Time of day to show, or null for all-day. */
  time: string | null;
  overdue: boolean;
  sortAt: number;
};

export type LaneWeek = { lane: Lane; items: StripItem[]; next: { label: string; when: string } | null };

/** "Mon 16 Nov" / "man 16. nov", spelled the same on server and browser (Intl punctuation differs between them). */
export function shortDay(date: Date, tz: string, locale: Locale = "en"): string {
  return formatShortDay(date, tz, locale);
}

/** "Nov" / "nov" */
export function monthName(date: Date, tz: string, locale: Locale = "en"): string {
  return monthShort(zonedParts(date, tz).month, locale);
}

const isEndOfDay = (date: Date, tz: string) => { const p = zonedParts(date, tz); return p.hour === 23 && p.minute === 59; };

/** "08:30", or null when the time carries no meaning (all-day, or 23:59 "by the end of the day"). */
export function timeOfDay(date: Date, precision: string | null | undefined, tz: string, locale: Locale = "en"): string | null {
  if (precision && precision !== "minute") return null;
  const p = zonedParts(date, tz);
  if (!precision && p.hour === 0 && p.minute === 0) return null;
  return isEndOfDay(date, tz) ? null : formatTime(date, tz, locale);
}

/** The seven days starting `offset` days from today. */
export function weekDays(now: Date, tz: string, offset: number, locale: Locale = "en"): Day[] {
  const start = addDaysInZone(startOfDayInZone(now, tz), offset, tz);
  return Array.from({ length: 7 }, (_, i) => {
    const date = addDaysInZone(start, i, tz);
    const p = zonedParts(date, tz);
    return {
      key: `${p.year}-${p.month}-${p.day}`,
      date,
      index: i,
      weekday: weekdayShort(p.weekday, locale),
      dayOfMonth: p.day,
      isToday: offset + i === 0,
      isWeekend: p.weekday >= 6,
    };
  });
}

/** An end exactly at local midnight belongs to the day before (all-day events end at the next midnight). */
function lastDay(start: Date, end: Date | null, now: Date, tz: string): number {
  if (!end || end <= start) return calendarDayDiff(start, now, tz);
  const p = zonedParts(end, tz);
  const atMidnight = p.hour === 0 && p.minute === 0 && p.second === 0;
  return calendarDayDiff(atMidnight ? new Date(end.getTime() - 1) : end, now, tz);
}

/** Which lane an event belongs in: each child it involves, or the shared row. */
function lanesForEvent(e: StripEvent, lanes: Lane[], family: Lane): Lane[] {
  const hit = lanes.filter((l) => l.userId && e.children.some((c) => c.userId === l.userId));
  return hit.length ? hit : [family];
}

function laneForReminder(r: StripReminder, lanes: Lane[], family: Lane): Lane {
  return lanes.find((l) => l.personNodeId && l.personNodeId === r.aboutNodeId) ?? family;
}

/**
 * Lay out events and open reminders on the seven days starting `offset` days from today, one row per lane.
 * Overdue reminders sit on today (only in the week that contains today). A lane with nothing this week gets its
 * next item after the week, if any.
 */
export function buildWeek(input: {
  lanes: Lane[]; family: Lane; events: StripEvent[]; reminders: StripReminder[]; now: Date; tz: string; offset: number; locale?: Locale;
}): LaneWeek[] {
  const { lanes, family, events, reminders, now, tz, offset } = input;
  const locale = input.locale ?? "en";
  const all = [...lanes, family];
  const items = new Map<string, StripItem[]>(all.map((l) => [l.key, []]));
  const later = new Map<string, { at: number; label: string; when: string }>();

  const noteLater = (lane: Lane, at: Date, label: string) => {
    const prev = later.get(lane.key);
    if (!prev || at.getTime() < prev.at) later.set(lane.key, { at: at.getTime(), label, when: shortDay(at, tz, locale) });
  };

  for (const e of events) {
    const start = new Date(e.startAt);
    const first = calendarDayDiff(start, now, tz);
    const last = lastDay(start, e.endAt ? new Date(e.endAt) : null, now, tz);
    if (last < 0) continue;
    const from = Math.max(first, offset, 0);
    const to = Math.min(last, offset + 6);
    for (const lane of lanesForEvent(e, lanes, family)) {
      if (first > offset + 6) { noteLater(lane, start, e.label); continue; }
      if (to < from) continue;
      items.get(lane.key)!.push({
        kind: "event", id: e.id, label: e.label, col: from - offset, span: to - from + 1,
        time: first === from ? timeOfDay(start, e.timePrecision, tz, locale) : null, overdue: false, sortAt: start.getTime(),
      });
    }
  }

  for (const r of reminders) {
    if (r.done) continue;
    const due = new Date(r.dueAt);
    const diff = calendarDayDiff(due, now, tz);
    const lane = laneForReminder(r, lanes, family);
    const overdue = diff < 0;
    const day = overdue ? 0 : diff;
    if (day > offset + 6) { noteLater(lane, due, displayTitle(r.title, r.aboutLabel)); continue; }
    if (day < offset) continue;
    items.get(lane.key)!.push({
      kind: "reminder", id: r.id, label: displayTitle(r.title, r.aboutLabel), col: day - offset, span: 1,
      time: overdue ? null : timeOfDay(due, "minute", tz, locale), overdue, sortAt: due.getTime(),
    });
  }

  return all.map((lane) => {
    const list = items.get(lane.key)!.sort((a, b) => a.col - b.col || a.sortAt - b.sortAt);
    const n = later.get(lane.key);
    return { lane, items: list, next: list.length === 0 && n ? { label: n.label, when: n.when } : null };
  });
}

/** "Emma: Permission slip deadline" reads as "Permission slip deadline" next to Emma's own colour. */
export function displayTitle(title: string, about: string | null): string {
  if (!about) return title;
  const first = about.split(/\s+/)[0];
  for (const prefix of [about, first]) {
    if (prefix && title.toLowerCase().startsWith(`${prefix.toLowerCase()}: `)) return title.slice(prefix.length + 2);
  }
  return title;
}

/** Replace raw ISO dates ("2026-11-16") in text with "Mon 16 Nov". */
export function humanizeDates(text: string, tz: string, locale: Locale = "en"): string {
  return text.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (m, y: string, mo: string, d: string) => {
    const date = zonedTimeToUtc(Number(y), Number(mo), Number(d), 12, 0, tz);
    return Number.isNaN(date.getTime()) || Number(mo) > 12 || Number(d) > 31 ? m : shortDay(date, tz, locale);
  });
}

/** When a reminder is due, as shown under its day heading: the day is left out when the heading already says it. */
export function dueLabel(due: Date, now: Date, tz: string, locale: Locale = "en"): string {
  const diff = calendarDayDiff(due, now, tz);
  const t = isEndOfDay(due, tz) ? todayT(locale)("today.when.endOfDay") : formatTime(due, tz, locale);
  if (diff === 0 || diff === 1) return t;
  return `${shortDay(due, tz, locale)}, ${t}`;
}

/** "Today", "Tomorrow", "Yesterday" or "Mon 16 Nov". */
export function relativeDay(date: Date, now: Date, tz: string, locale: Locale = "en"): string {
  return relativeDayLabel(date, now, tz, locale);
}
