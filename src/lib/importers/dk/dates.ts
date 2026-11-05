/**
 * Danish dates as public letters, sundhed.dk printouts and notification emails write them (pure):
 * "15. december 2026", "15. dec. 2026", "15.12.2026", "15-12-2026", "15/12/2026", "2026-12-15", optionally
 * followed by "kl. 10.30". Returned as a calendar day (and a time when one is given), never guessed.
 */

const MONTHS: Record<string, number> = {
  januar: 1, jan: 1, january: 1,
  februar: 2, feb: 2, february: 2,
  marts: 3, mar: 3, march: 3,
  april: 4, apr: 4,
  maj: 5, may: 5,
  juni: 6, jun: 6, june: 6,
  juli: 7, jul: 7, july: 7,
  august: 8, aug: 8,
  september: 9, sep: 9, sept: 9,
  oktober: 10, okt: 10, oct: 10, october: 10,
  november: 11, nov: 11,
  december: 12, dec: 12,
};

export type DkDate = { year: number; month: number; day: number; hour?: number; minute?: number; text: string; index: number };

const MONTH_NAMES = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join("|");
const TIME = String.raw`(?:\s*(?:,\s*)?(?:kl\.?|klokken|at)\s*(\d{1,2})[.:](\d{2}))?`;
/** Every date form, each with an optional time after it. Groups: named (d, month, y) | numeric (d, m, y) | iso (y, m, d). */
export const DATE_SOURCE = String.raw`(?:(\d{1,2})\.?\s+(${MONTH_NAMES})\.?\s+(\d{4})|(\d{1,2})[./-](\d{1,2})[./-](\d{4})|(\d{4})-(\d{2})-(\d{2}))${TIME}`;

function valid(y: number, m: number, d: number): boolean {
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1) return false;
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d <= days;
}

function fromMatch(m: RegExpExecArray): DkDate | null {
  let y: number, mo: number, d: number;
  if (m[1]) { d = +m[1]; mo = MONTHS[m[2].toLowerCase()]; y = +m[3]; }
  else if (m[4]) { d = +m[4]; mo = +m[5]; y = +m[6]; }
  else { y = +m[7]; mo = +m[8]; d = +m[9]; }
  if (!mo || !valid(y, mo, d)) return null;
  const out: DkDate = { year: y, month: mo, day: d, text: m[0].trim(), index: m.index };
  if (m[10] && m[11]) {
    const h = +m[10], mi = +m[11];
    if (h < 24 && mi < 60) { out.hour = h; out.minute = mi; }
  }
  return out;
}

/** All dates in a text, in order. */
export function findDates(text: string): DkDate[] {
  const re = new RegExp(DATE_SOURCE, "gi");
  const out: DkDate[] = [];
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const d = fromMatch(m);
    if (d) out.push(d);
  }
  return out;
}

/** The first date at the very start of `text` (after spaces and "den"), if any. */
export function dateAtStart(text: string): DkDate | null {
  const m = new RegExp(String.raw`^\s*(?:den\s+|d\.\s*)?` + DATE_SOURCE, "i").exec(text);
  if (!m) return null;
  // The leading part shifts group numbers by none (it has no groups), so the same reader applies.
  return fromMatch(Object.assign(m, { index: 0 }));
}

/** Copenhagen wall time → UTC, close enough for a reminder (CEST from the last Sunday of March to that of October). */
export function copenhagenToIso(d: Pick<DkDate, "year" | "month" | "day" | "hour" | "minute">, fallbackHour = 9): string {
  const lastSunday = (y: number, month: number) => {
    const last = new Date(Date.UTC(y, month, 0));
    return last.getUTCDate() - last.getUTCDay();
  };
  const summer = (d.month > 3 && d.month < 10)
    || (d.month === 3 && d.day >= lastSunday(d.year, 3))
    || (d.month === 10 && d.day < lastSunday(d.year, 10));
  const h = (d.hour ?? fallbackHour) - (summer ? 2 : 1);
  return new Date(Date.UTC(d.year, d.month - 1, d.day, h, d.minute ?? 0)).toISOString();
}

export const isoDay = (d: Pick<DkDate, "year" | "month" | "day">) =>
  `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;

const DA_MONTHS = ["januar", "februar", "marts", "april", "maj", "juni", "juli", "august", "september", "oktober", "november", "december"];
const EN_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "15 December 2026" / "15. december 2026", for the few words an importer writes itself. */
export function sayDay(d: Pick<DkDate, "year" | "month" | "day">, locale: "en" | "da"): string {
  return locale === "da" ? `${d.day}. ${DA_MONTHS[d.month - 1]} ${d.year}` : `${d.day} ${EN_MONTHS[d.month - 1]} ${d.year}`;
}
