/**
 * Pure rules for the "Needs attention" strip: contact cadence per circle, upcoming birthdays, low wellbeing.
 * Dates are calendar dates in the household's local time; pass `today` explicitly in tests.
 */
import { differenceInCalendarDays } from "date-fns";

/** Days without contact before someone shows up in "Needs attention". Circles without a cadence never do. */
export const DEFAULT_CADENCE: Record<string, number> = { family: 14, close: 30, social: 90, friends: 90 };

/** Kinds you normally live with — no contact reminders for them. */
export const LIVE_WITH_KINDS = new Set(["partner", "child"]);

export const BIRTHDAY_WINDOW_DAYS = 14;
export const LOW_WELLBEING = 2;

export type ParsedBirthday = { year: number | null; month: number; day: number };

/** Parse "YYYY-MM-DD", "--MM-DD" or an ISO timestamp. Returns null for anything else. */
export function parseBirthday(v: unknown): ParsedBirthday | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return valid({ year: +m[1], month: +m[2], day: +m[3] });
  m = /^--(\d{2})-(\d{2})$/.exec(s);
  if (m) return valid({ year: null, month: +m[1], day: +m[2] });
  return null;
}
function valid(b: ParsedBirthday): ParsedBirthday | null {
  if (b.month < 1 || b.month > 12 || b.day < 1 || b.day > 31) return null;
  const probeYear = b.year ?? 2000; // leap year so 29 Feb without a year is allowed
  const d = new Date(probeYear, b.month - 1, b.day);
  return d.getMonth() === b.month - 1 ? b : null;
}

function occurrence(b: ParsedBirthday, year: number): Date {
  // 29 Feb in a non-leap year is celebrated on 28 Feb.
  const leap = new Date(year, 1, 29).getMonth() === 1;
  const day = b.month === 2 && b.day === 29 && !leap ? 28 : b.day;
  return new Date(year, b.month - 1, day);
}

export type NextBirthday = { date: Date; daysUntil: number; turning: number | null };

/** The next time this birthday happens on or after `today` (local calendar), with days to go and the age turned. */
export function nextBirthday(birthday: unknown, today: Date = new Date()): NextBirthday | null {
  const b = parseBirthday(birthday);
  if (!b) return null;
  const t0 = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  let year = t0.getFullYear();
  let date = occurrence(b, year);
  if (date < t0) date = occurrence(b, ++year);
  const turning = b.year !== null ? year - b.year : null;
  return { date, daysUntil: differenceInCalendarDays(date, t0), turning: turning !== null && turning >= 0 ? turning : null };
}

export type AttentionInput = {
  id: string; label: string; kind: string | null; circle: string;
  lastContactAt: Date | null; createdAt: Date;
  birthday?: unknown;
  latestWellbeing?: { score: number; at: Date; note: string | null } | null;
  /** Lives in the household (has a login) or is the viewer — no contact reminders. */
  householdMember?: boolean;
};

export type AttentionItem =
  | { personId: string; label: string; reason: "contact"; daysSince: number | null; cadenceDays: number; circle: string }
  | { personId: string; label: string; reason: "birthday"; date: string; daysUntil: number; turning: number | null }
  | { personId: string; label: string; reason: "wellbeing"; score: number; at: string; note: string | null };

/** Whether this person is overdue for contact under their circle's cadence. */
export function contactOverdue(p: AttentionInput, today: Date, cadence: Record<string, number> = DEFAULT_CADENCE): { daysSince: number | null; cadenceDays: number } | null {
  const days = cadence[p.circle];
  if (!days || p.householdMember || (p.kind && LIVE_WITH_KINDS.has(p.kind))) return null;
  if (p.lastContactAt) {
    const since = differenceInCalendarDays(today, p.lastContactAt);
    return since > days ? { daysSince: since, cadenceDays: days } : null;
  }
  // Never logged: only nag once they've been in the graph longer than the cadence.
  return differenceInCalendarDays(today, p.createdAt) > days ? { daysSince: null, cadenceDays: days } : null;
}

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/**
 * Everything that needs attention, most urgent first: low wellbeing, then birthdays (soonest first), then overdue
 * contact (longest overdue first).
 */
export function attentionItems(people: AttentionInput[], today: Date = new Date(), cadence: Record<string, number> = DEFAULT_CADENCE): AttentionItem[] {
  const wellbeing: AttentionItem[] = [], birthdays: (AttentionItem & { reason: "birthday" })[] = [], contact: (AttentionItem & { reason: "contact" })[] = [];
  for (const p of people) {
    if (p.latestWellbeing && p.latestWellbeing.score <= LOW_WELLBEING) {
      wellbeing.push({ personId: p.id, label: p.label, reason: "wellbeing", score: p.latestWellbeing.score, at: p.latestWellbeing.at.toISOString(), note: p.latestWellbeing.note });
    }
    const nb = nextBirthday(p.birthday, today);
    if (nb && nb.daysUntil <= BIRTHDAY_WINDOW_DAYS) birthdays.push({ personId: p.id, label: p.label, reason: "birthday", date: ymd(nb.date), daysUntil: nb.daysUntil, turning: nb.turning });
    const od = contactOverdue(p, today, cadence);
    if (od) contact.push({ personId: p.id, label: p.label, reason: "contact", circle: p.circle, ...od });
  }
  birthdays.sort((a, b) => a.daysUntil - b.daysUntil);
  const overdueBy = (c: { daysSince: number | null; cadenceDays: number }) => (c.daysSince === null ? 0 : c.daysSince - c.cadenceDays);
  contact.sort((a, b) => overdueBy(b) - overdueBy(a));
  return [...wellbeing, ...birthdays, ...contact];
}
