/**
 * The document's own date: when a letter was written, an email sent, a photo taken, a scan dated. Pure.
 * Several readers propose a date; `pickDocumentDate` decides by how much each one can be trusted:
 *   email Date header > photo EXIF (DateTimeOriginal) > the date the document states (read by the model) >
 *   a date printed at the top of the text (letterhead, "Dato:") > PDF metadata (often the scan or export date) >
 *   the sent date of the email an attachment came with.
 * Upload time is never a document date.
 */

export type DatePrecision = "minute" | "day" | "month" | "year";
export type DateOrigin = "email" | "exif" | "model" | "text" | "pdf" | "parent";
export type DateCandidate = { at: Date; precision: DatePrecision; origin: DateOrigin; quote?: string };
export type DocumentDate = DateCandidate;

export const ORIGIN_RANK: Record<DateOrigin, number> = { email: 0, exif: 1, model: 2, text: 3, pdf: 4, parent: 5 };

export const ORIGIN_LABEL: Record<DateOrigin, string> = {
  email: "the email's sent date",
  exif: "when the photo was taken",
  model: "the date written in it",
  text: "the date at the top of the text",
  pdf: "the PDF's creation date",
  parent: "the email it was attached to",
};

/** A plausible document date: not before 1850, not more than a year ahead. */
export function plausible(d: Date, now = new Date()): boolean {
  const t = d.getTime();
  return Number.isFinite(t) && d.getUTCFullYear() >= 1850 && t <= now.getTime() + 366 * 24 * 3600_000;
}

export function pickDocumentDate(cands: (DateCandidate | null | undefined)[], now = new Date()): DocumentDate | null {
  const ok = cands.filter((c): c is DateCandidate => !!c && plausible(c.at, now));
  if (!ok.length) return null;
  return ok.sort((a, b) => ORIGIN_RANK[a.origin] - ORIGIN_RANK[b.origin] || precisionRank(a.precision) - precisionRank(b.precision))[0];
}

const precisionRank = (p: DatePrecision) => ({ minute: 0, day: 1, month: 2, year: 3 })[p];

/* ── PDF metadata dates: "D:20240303120000+01'00'" ───────────────────────────────────────────────────── */

export function parsePdfDate(v: unknown): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v !== "string") return null;
  const m = v.trim().match(/^(?:D:)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(Z|[+-]\d{2}'?\d{2}'?)?/);
  if (!m) return null;
  const [, y, mo = "01", d = "01", h = "00", mi = "00", s = "00", tz] = m;
  let off = 0;
  if (tz && tz !== "Z") {
    const t = tz.replace(/'/g, "");
    off = (t[0] === "-" ? -1 : 1) * (Number(t.slice(1, 3)) * 60 + Number(t.slice(3, 5) || 0));
  }
  const ms = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s) - off * 60_000;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date;
}

/* ── Dates printed in text (Danish and English) ──────────────────────────────────────────────────────── */

const MONTHS: Record<string, number> = {
  januar: 1, january: 1, jan: 1, februar: 2, february: 2, feb: 2, marts: 3, march: 3, mar: 3, april: 4, apr: 4,
  maj: 5, may: 5, juni: 6, june: 6, jun: 6, juli: 7, july: 7, jul: 7, august: 8, aug: 8, september: 9, sep: 9, sept: 9,
  oktober: 10, october: 10, okt: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12,
};
const MONTH_RE = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join("|");

export type TextDate = { at: Date; precision: "day" | "month"; index: number; quote: string };

/** Noon UTC on a calendar day, so the day survives any display time zone. */
const dayAt = (y: number, m: number, d: number): Date | null => {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d, 12));
  return dt.getUTCMonth() === m - 1 ? dt : null;
};

/** Every date written out in a text, in order: "3. marts 2024", "3 March 2024", "March 3, 2024", "2024-03-03", "03.03.2024", "3/3-2024". */
export function findTextDates(text: string): TextDate[] {
  const out: TextDate[] = [];
  const push = (at: Date | null, precision: TextDate["precision"], index: number, quote: string) => { if (at) out.push({ at, precision, index, quote }); };
  const year = (s: string) => { const n = Number(s); return s.length === 2 ? (n > 50 ? 1900 + n : 2000 + n) : n; };
  let m: RegExpExecArray | null;

  const iso = /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g;
  while ((m = iso.exec(text))) push(dayAt(+m[1], +m[2], +m[3]), "day", m.index, m[0]);

  // Day-first numeric (Danish): 03.03.2024, 3/3 2024, 3/3-2024, 03-03-2024
  const dmy = /\b(\d{1,2})[./-](\d{1,2})[./\- ]\s?(\d{4}|\d{2})\b/g;
  while ((m = dmy.exec(text))) {
    if (/\d{4}-\d{1,2}-\d{1,2}/.test(text.slice(Math.max(0, m.index - 5), m.index + m[0].length))) continue;
    push(dayAt(year(m[3]), +m[2], +m[1]), "day", m.index, m[0]);
  }

  const named = new RegExp(`\\b(\\d{1,2})\\.?\\s+(${MONTH_RE})\\.?,?\\s+(\\d{4})\\b`, "gi");
  while ((m = named.exec(text))) push(dayAt(+m[3], MONTHS[m[2].toLowerCase()], +m[1]), "day", m.index, m[0]);

  const us = new RegExp(`\\b(${MONTH_RE})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, "gi");
  while ((m = us.exec(text))) push(dayAt(+m[3], MONTHS[m[1].toLowerCase()], +m[2]), "day", m.index, m[0]);

  const monthOnly = new RegExp(`(?<![\\d.]\\s?)\\b(${MONTH_RE})\\s+(\\d{4})\\b`, "gi");
  while ((m = monthOnly.exec(text))) {
    const idx = m.index;
    if (out.some((d) => idx >= d.index && idx < d.index + d.quote.length)) continue;
    push(dayAt(+m[2], MONTHS[m[1].toLowerCase()], 1), "month", idx, m[0]);
  }
  return out.sort((a, b) => a.index - b.index);
}

const WEEKDAYS = new Set(["mandag", "tirsdag", "onsdag", "torsdag", "fredag", "lørdag", "søndag", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "den", "the"]);

/** "København, 3. marts 2024", "Torsdag den 3. marts 2024", "3 March 2024": a line that is only a date (and a place). */
function isDateLine(line: string, d: TextDate): boolean {
  const i = line.indexOf(d.quote);
  const after = line.slice(i + d.quote.length).replace(/[.,\s]+/g, "");
  if (after) return false;
  const before = line.slice(0, i).trim();
  if (!before) return true;
  if (/,$/.test(before)) {
    const words = before.replace(/,$/, "").split(/[\s,]+/).filter(Boolean);
    const place = words.filter((w) => !WEEKDAYS.has(w.toLowerCase()));
    return place.length <= 3 && place.every((w) => /^[\p{L}'’.-]+$/u.test(w));
  }
  return before.split(/\s+/).every((w) => WEEKDAYS.has(w.toLowerCase().replace(/[,.]$/, "")));
}

/**
 * The date a letter states about itself: a "Dato:"/"Dateret"/"Dated" line, or a date line near the top that holds
 * nothing but an optional place and the date ("København, 3. marts 2024", "Torsdag den 3. marts 2024"). Dates inside
 * sentences ("the trip is on 19 November") are what the letter is about, not when it was written, so they are not
 * used; neither is an English "Date:" line, which on appointment cards is the appointment.
 */
export function letterDate(text: string, now = new Date()): DateCandidate | null {
  const labelled = text.match(/^\s*(?:dato|dateret|dated)\s*[:.]?\s*(.{4,40})$/im);
  if (labelled) {
    const d = findTextDates(labelled[1]).find((x) => plausible(x.at, now));
    if (d) return { at: d.at, precision: d.precision, origin: "text", quote: labelled[0].trim() };
  }
  const lines = text.slice(0, 1500).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 12);
  for (const line of lines) {
    if (line.length > 70) continue;
    const d = findTextDates(line).find((x) => plausible(x.at, now));
    if (!d) continue;
    if (isDateLine(line, d)) return { at: d.at, precision: d.precision, origin: "text", quote: line };
  }
  return null;
}

/**
 * A date the model says the document states, kept only when it can be checked: the model must quote the words that
 * give it, the quote must be in the text, and the quote must hold that same date. (Models otherwise like to answer
 * "today" for an undated letter.)
 */
export function checkStatedDate(stated: { at: Date; precision: DatePrecision; quote?: string } | undefined, text: string, now = new Date()): DateCandidate | null {
  if (!stated?.quote || !plausible(stated.at, now)) return null;
  const norm = (x: string) => x.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
  const q = norm(stated.quote);
  if (q.length < 4 || !norm(text).includes(q.slice(0, 60))) return null;
  const ymd = (d: Date) => d.toISOString().slice(0, stated.precision === "month" ? 7 : stated.precision === "year" ? 4 : 10);
  // Compare calendar days with a 12-hour shift, so "2024-03-03" at local midnight matches a noon-UTC parse.
  const shifted = (d: Date) => new Date(d.getTime() + 12 * 3600_000);
  const want = ymd(shifted(stated.at));
  const hit = findTextDates(stated.quote).some((d) => ymd(shifted(d.at)) === want || ymd(d.at) === ymd(stated.at));
  return hit ? { at: stated.at, precision: stated.precision, origin: "model", quote: stated.quote } : null;
}
