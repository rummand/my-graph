/**
 * When something is due, as letters, bills, school messages, emails and chats say it (pure). Danish and English:
 *
 *   absolute   "15. december 2026", "15.12.2026", "2026-12-15", "December 15, 2026", "15 Dec 2026" (+ "kl. 10.30")
 *   relative   "inden 14 dage fra modtagelsen", "within 14 days", "senest 4 uger efter", "om to uger", "in 3 days"
 *   weekdays   "inden fredag", "på mandag", "by Friday", "next Tuesday"
 *   near       "i dag", "i morgen", "i overmorgen", "today", "tomorrow", "tonight"
 *   vague      "i næste uge", "next week", "i weekenden", "this weekend", "sidst på måneden", "end of the month", "snart"
 *
 * Everything is a Copenhagen calendar day (and a time when one is given). Vague wording gets a best date (the end of
 * the span, so nothing is late because of us) with dueKind "approx" and the wording kept for the label.
 */
import { DATE_SOURCE, copenhagenToIso, findDates, isoDay, type DkDate } from "@/lib/importers/dk/dates";
import type { DueKind } from "../types";

export type Day = { year: number; month: number; day: number; hour?: number; minute?: number };

export type When = {
  day: Day;
  dueKind: DueKind;
  /** The words it came from ("next week", "inden 14 dage fra modtagelsen"), for a vague or relative one. */
  words: string | null;
  /** Where in the text the wording starts (relative to the text searched). */
  index: number;
  text: string;
};

const pad = (n: number) => String(n).padStart(2, "0");
export const dayKey = (d: Day) => `${d.year}-${pad(d.month)}-${pad(d.day)}`;

/** The Copenhagen calendar day of an instant. */
export function copenhagenDay(at: Date): Day {
  const f = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Copenhagen", year: "numeric", month: "2-digit", day: "2-digit" });
  const p: Record<string, number> = {};
  for (const x of f.formatToParts(at)) if (x.type !== "literal") p[x.type] = Number(x.value);
  return { year: p.year, month: p.month, day: p.day };
}

/** Day arithmetic on calendar days (no time zones involved). */
export function addDays(d: Day, n: number): Day {
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day + n));
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}

/** Months later (or earlier), clamped to the month's last day (31 Jan + 1 month = 28/29 Feb). */
export function addMonths(d: Day, n: number): Day {
  const first = new Date(Date.UTC(d.year, d.month - 1 + n, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return { year: first.getUTCFullYear(), month: first.getUTCMonth() + 1, day: Math.min(d.day, last) };
}

export const endOfMonth = (d: Day): Day => ({ year: d.year, month: d.month, day: new Date(Date.UTC(d.year, d.month, 0)).getUTCDate() });

/** 0 = Monday … 6 = Sunday. */
export const weekday = (d: Day) => (new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay() + 6) % 7;

export const compareDays = (a: Day, b: Day) => dayKey(a).localeCompare(dayKey(b));

/** The ISO instant a due day stands for: its own time, else noon in Copenhagen (the same day in every reader's view). */
export function dueIso(d: Day): string {
  return copenhagenToIso({ year: d.year, month: d.month, day: d.day, hour: d.hour ?? 12, minute: d.hour !== undefined ? d.minute ?? 0 : 0 });
}

/* ── Words ────────────────────────────────────────────────────────────────────────────────────────────────── */

const NUMBER_WORDS: Record<string, number> = {
  en: 1, et: 1, one: 1, a: 1, an: 1, to: 2, two: 2, tre: 3, three: 3, fire: 4, four: 4, fem: 5, five: 5, seks: 6, six: 6,
  syv: 7, seven: 7, otte: 8, eight: 8, ni: 9, nine: 9, ti: 10, ten: 10, tolv: 12, twelve: 12, fjorten: 14, fourteen: 14,
  femten: 15, fifteen: 15, tyve: 20, twenty: 20, tredive: 30, thirty: 30,
};
const NUM = String.raw`(\d{1,3}|${Object.keys(NUMBER_WORDS).sort((a, b) => b.length - a.length).join("|")})`;
export const numberOf = (s: string) => (/^\d+$/.test(s) ? Number(s) : NUMBER_WORDS[s.toLowerCase()] ?? NaN);

const UNIT = String.raw`(hverdage|arbejdsdage|dage|dag|døgn|uger|uge|måneder|måned|år|business\s+days|working\s+days|days|day|weeks|week|months|month|years|year)`;

export type Unit = "day" | "workday" | "week" | "month" | "year";
export function unitOf(s: string): Unit {
  const u = s.toLowerCase();
  if (/hverdag|arbejdsdag|business|working/.test(u)) return "workday";
  if (/^(dag|dage|døgn|day|days)/.test(u)) return "day";
  if (/^(uge|uger|week)/.test(u)) return "week";
  if (/^(måned|month)/.test(u)) return "month";
  return "year";
}

export function addPeriod(d: Day, n: number, unit: Unit): Day {
  switch (unit) {
    case "day": return addDays(d, n);
    case "week": return addDays(d, 7 * n);
    case "month": return addMonths(d, n);
    case "year": return addMonths(d, 12 * n);
    case "workday": {
      let out = d, left = n;
      const step = n >= 0 ? 1 : -1;
      while (left !== 0) { out = addDays(out, step); if (weekday(out) < 5) left -= step; }
      return out;
    }
  }
}

const WEEKDAYS: Record<string, number> = {
  mandag: 0, tirsdag: 1, onsdag: 2, torsdag: 3, fredag: 4, lørdag: 5, søndag: 6,
  monday: 0, tuesday: 1, wednesday: 2, thursday: 3, friday: 4, saturday: 5, sunday: 6,
  mon: 0, tue: 1, wed: 2, thu: 3, fri: 4,
};
const WEEKDAY_SOURCE = String.raw`(mandag|tirsdag|onsdag|torsdag|fredag|lørdag|søndag|monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:en)?`;

/** The next such weekday after `from` (a weekday named on that same day means a week later, "next" adds nothing more). */
export function nextWeekday(from: Day, wd: number, next = false): Day {
  let diff = (wd - weekday(from) + 7) % 7;
  if (diff === 0) diff = 7;
  // "næste fredag" said on a Monday: most people mean the coming Friday; only "next" on the weekend skips one more.
  if (next && diff <= 1) diff += 7;
  return addDays(from, diff);
}

const MONTHS_EN: Record<string, number> = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4, may: 5, june: 6, jun: 6, july: 7, jul: 7,
  august: 8, aug: 8, september: 9, sep: 9, sept: 9, october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12,
};
const MONTHS_DA: Record<string, number> = {
  januar: 1, februar: 2, marts: 3, april: 4, maj: 5, juni: 6, juli: 7, august: 8, september: 9, oktober: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, okt: 10, nov: 11, dec: 12,
};
const MONTH_ALL = [...new Set([...Object.keys(MONTHS_EN), ...Object.keys(MONTHS_DA)])].sort((a, b) => b.length - a.length).join("|");
const monthOf = (s: string) => MONTHS_EN[s.toLowerCase()] ?? MONTHS_DA[s.toLowerCase()];

function valid(y: number, m: number, d: number) {
  return y >= 1900 && y <= 2200 && m >= 1 && m <= 12 && d >= 1 && d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** "December 15, 2026" and "Dec 15th 2026", which the Danish reader doesn't know. */
function englishDates(text: string): DkDate[] {
  const re = new RegExp(String.raw`\b(${MONTH_ALL})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})`, "giu");
  const out: DkDate[] = [];
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const mo = monthOf(m[1]), d = +m[2], y = +m[3];
    if (mo && valid(y, mo, d)) out.push({ year: y, month: mo, day: d, text: m[0], index: m.index });
  }
  return out;
}

/** "15. december" / "1. januar" / "15th of December" without a year: the next such day on or after `anchor`. */
function yearlessDates(text: string, anchor: Day): DkDate[] {
  const out: DkDate[] = [];
  const re = new RegExp(String.raw`(?<![\d.])(\d{1,2})(?:\.|st|nd|rd|th)?\s+(?:of\s+)?(${MONTH_ALL})\b(?!\.?\s+\d{4})(?!\s*\d)`, "giu");
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const d = +m[1], mo = monthOf(m[2]);
    if (!mo) continue;
    let y = anchor.year;
    if (!valid(y, mo, d)) continue;
    if (compareDays({ year: y, month: mo, day: d }, anchor) < 0) y += 1;
    const t = /^\s*(?:,\s*)?(?:kl\.?|klokken|at)\s*(\d{1,2})[.:](\d{2})/i.exec(text.slice(m.index + m[0].length));
    const time = t && +t[1] < 24 && +t[2] < 60 ? { hour: +t[1], minute: +t[2] } : {};
    out.push({ year: y, month: mo, day: d, ...time, text: t ? m[0] + t[0] : m[0], index: m.index });
  }
  // "15.12." / "15/12" (a day and month, nothing after): only with the trailing dot, or a slash and no year.
  const re2 = /(?<![\d./-])(\d{1,2})[./](\d{1,2})\.?(?![\d./-])/g;
  for (let m = re2.exec(text); m; m = re2.exec(text)) {
    if (!/\.$/.test(m[0]) && !m[0].includes("/")) continue;
    // "kl. 9.05." is a time, not the 9th of May.
    if (/(?:kl|klokken|at)\.?\s*$/i.test(text.slice(Math.max(0, m.index - 9), m.index))) continue;
    const d = +m[1], mo = +m[2];
    if (!valid(anchor.year, mo, d)) continue;
    let y = anchor.year;
    if (compareDays({ year: y, month: mo, day: d }, anchor) < 0) y += 1;
    out.push({ year: y, month: mo, day: d, text: m[0], index: m.index });
  }
  return out;
}

/** Every absolute date in a text, first first (year-less ones resolved against `anchor`). */
export function datesIn(text: string, anchor?: Day): DkDate[] {
  const full = [...findDates(text), ...englishDates(text)];
  const taken = (i: number) => full.some((d) => i >= d.index && i < d.index + d.text.length);
  const loose = anchor ? yearlessDates(text, anchor).filter((d) => !taken(d.index)) : [];
  return [...full, ...loose].sort((a, b) => a.index - b.index);
}

const toWhen = (d: DkDate, dueKind: DueKind, words: string | null = null): When => ({
  day: { year: d.year, month: d.month, day: d.day, ...(d.hour !== undefined ? { hour: d.hour, minute: d.minute ?? 0 } : {}) },
  dueKind, words, index: d.index, text: d.text,
});

/**
 * The first "when" in a phrase or sentence. `anchor` is the day it was written (a letter's date, a message's day);
 * relative and vague wording counts from there. Absolute dates win over relative wording in the same text.
 */
export function whenIn(text: string, anchor: Day): When | null {
  const found = allWhens(text, anchor);
  return found[0] ?? null;
}

/** Every "when" in a text, absolute dates first, then relative wording, each in text order. */
export function allWhens(text: string, anchor: Day): When[] {
  const out: When[] = datesIn(text, anchor).map((d) => toWhen(d, d.hour !== undefined ? "date" : "deadline"));
  const covered = (i: number) => out.some((w) => i >= w.index && i < w.index + w.text.length);
  const add = (w: When) => { if (!covered(w.index)) out.push(w); };
  const t = text;
  let m: RegExpExecArray | null;

  // "inden 14 dage fra modtagelsen", "within 14 days", "senest 4 uger efter", "om to uger", "in 3 days".
  const rel = new RegExp(String.raw`(?<![\p{L}])(inden\s+for|inden|indenfor|senest|om|within|in|after|efter)\s+${NUM}\s+${UNIT}(?:\s+(?:fra|efter|from|of|after)\s+(?:modtagelsen(?:\s+af\s+(?:dette\s+)?brev(?:et)?)?|brevets\s+dato|dags\s+dato|datoen|receipt(?:\s+of\s+this\s+letter)?|the\s+date\s+of\s+this\s+letter|today|i\s+dag))?`, "giu");
  for (m = rel.exec(t); m; m = rel.exec(t)) {
    const n = numberOf(m[2]);
    if (!Number.isFinite(n) || n <= 0 || n > 400) continue;
    // "om 2 uger" and "in 3 days" are when; "inden 14 dage" is a deadline.
    const lead = m[1].toLowerCase();
    if ((lead === "in" || lead === "om" || lead === "after" || lead === "efter") && !/\b(dage|uger|måneder|days|weeks|months)\b/i.test(m[3])) continue;
    add({ day: addPeriod(anchor, n, unitOf(m[3])), dueKind: lead === "om" || lead === "in" ? "approx" : "deadline", words: m[0].trim(), index: m.index, text: m[0] });
  }

  // Near days.
  const near: [RegExp, number][] = [
    [/(?<![\p{L}])(i\s+overmorgen|the\s+day\s+after\s+tomorrow)(?![\p{L}])/giu, 2],
    [/(?<![\p{L}])(i\s+morgen(?:\s+tidlig)?|tomorrow)(?![\p{L}])/giu, 1],
    [/(?<![\p{L}])(i\s+dag|i\s+aften|today|tonight|this\s+evening)(?![\p{L}])/giu, 0],
  ];
  for (const [re, n] of near) for (m = re.exec(t); m; m = re.exec(t)) add({ day: addDays(anchor, n), dueKind: "date", words: m[0], index: m.index, text: m[0] });

  // Weekdays: "inden fredag", "på mandag", "by Friday", "next Tuesday", "fredag den 12." (absolute wins, above).
  const wd = new RegExp(String.raw`(?<![\p{L}])(?:(næste|next|på|on|by|before|inden|senest|til|until|this|denne|kommende|på\s+førstkommende)\s+)?${WEEKDAY_SOURCE}(?![\p{L}])`, "giu");
  for (m = wd.exec(t); m; m = wd.exec(t)) {
    const lead = (m[1] ?? "").toLowerCase();
    // "fredag den 12. april 2026", "Friday 12 April": the date right after the weekday says the day.
    const end = m.index + m[0].length;
    if (out.some((w) => w.index >= end && w.index - end <= 6 && w.words === null)) continue;
    // A bare weekday name in running text ("fredag var vi …") is not a due day.
    if (!lead) continue;
    const day = nextWeekday(anchor, WEEKDAYS[m[2].toLowerCase()], lead === "næste" || lead === "next");
    add({ day, dueKind: /inden|senest|by|before|until|til/.test(lead) ? "deadline" : "date", words: m[0].trim(), index: m.index, text: m[0] });
  }

  // Vague spans: a best date at the end of the span.
  const vague: [RegExp, (a: Day) => Day][] = [
    [/(?<![\p{L}])((?:i\s+)?(?:løbet\s+af\s+)?næste\s+uge|next\s+week|in\s+the\s+coming\s+week)(?![\p{L}])/giu, (a) => addDays(a, 7 - weekday(a) + 4)],
    [/(?<![\p{L}])((?:i\s+)?(?:løbet\s+af\s+)?denne\s+uge|i\s+ugens\s+løb|this\s+week|later\s+this\s+week|by\s+the\s+end\s+of\s+the\s+week|sidst\s+på\s+ugen|end\s+of\s+(?:the\s+)?week)(?![\p{L}])/giu, (a) => addDays(a, Math.max(0, 4 - weekday(a)))],
    [/(?<![\p{L}])((?:i|til|på)\s+weekenden|(?:this|over\s+the|at\s+the)\s+weekend)(?![\p{L}])/giu, (a) => addDays(a, weekday(a) <= 5 ? 5 - weekday(a) : 6)],
    [/(?<![\p{L}])(sidst\s+på\s+måneden|slutningen\s+af\s+måneden|inden\s+månedens\s+udgang|ultimo\s+måneden|(?:by\s+)?(?:the\s+)?end\s+of\s+(?:the|this)\s+month)(?![\p{L}])/giu, (a) => endOfMonth(a)],
    [/(?<![\p{L}])(næste\s+måned|next\s+month)(?![\p{L}])/giu, (a) => endOfMonth(addMonths({ ...a, day: 1 }, 1))],
  ];
  for (const [re, f] of vague) for (m = re.exec(t); m; m = re.exec(t)) add({ day: f(anchor), dueKind: "approx", words: m[0].trim(), index: m.index, text: m[0] });

  // "ultimo december", "primo marts", "end of March", "midt i januar": approx, in that month.
  const span = new RegExp(String.raw`(?<![\p{L}])(ultimo|primo|medio|sidst\s+i|først\s+i|midt\s+i|end\s+of|early|mid|late|beginning\s+of)\s+(${MONTH_ALL})(?![\p{L}])(?:\s+(\d{4}))?`, "giu");
  for (m = span.exec(t); m; m = span.exec(t)) {
    const mo = monthOf(m[2]);
    if (!mo) continue;
    let y = m[3] ? +m[3] : anchor.year;
    if (!m[3] && mo < anchor.month) y += 1;
    const which = m[1].toLowerCase();
    const day = /ultimo|sidst|end|late/.test(which) ? endOfMonth({ year: y, month: mo, day: 1 }) : /primo|først|early|beginning/.test(which) ? { year: y, month: mo, day: 7 } : { year: y, month: mo, day: 15 };
    add({ day, dueKind: "approx", words: m[0].trim(), index: m.index, text: m[0] });
  }
  return out.sort((a, b) => a.index - b.index);
}

/** "snart", "soon", "asap": a wish for soon with no date at all. */
export const SOON = /(?<![\p{L}])(snarest(?:\s+muligt)?|hurtigst\s+muligt|snart|asap|as\s+soon\s+as\s+possible|soon|when\s+you\s+can|når\s+du\s+kan)(?![\p{L}])/iu;

/** The anchor day of a text: its date, else today. */
export const anchorOf = (docDate: Date | null | undefined, now: Date): Day => copenhagenDay(docDate ?? now);

/** Re-exported so detectors need one import for dates. */
export { DATE_SOURCE, isoDay };
