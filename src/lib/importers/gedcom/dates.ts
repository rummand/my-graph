/**
 * GEDCOM dates (pure): `3 MAR 1921`, `MAR 1921`, `1921`, `ABT 1850`, `BEF 1900`, `AFT 1890`, `BET 1850 AND 1860`,
 * `FROM 1940 TO 1945`, `EST`/`CAL`, `INT 1850 (text)`, dual dates `1720/21`, calendar escapes (`@#DJULIAN@`),
 * GEDCOM 7 `JULIAN 1700`, and what Danish programs write instead (`3. marts 1921`, `ca. 1850`, `03.03.1921`,
 * `1921-03-03`, `før 1900`, `mellem 1850 og 1860`). Only an exact date becomes a stored date; the rest stays words.
 */

export type GDate = { y: number; m?: number; d?: number };
export type DateQual = "exact" | "about" | "before" | "after" | "between" | "from" | "to" | "range" | "phrase";
export type ParsedDate = { qual: DateQual; a?: GDate; b?: GDate; raw: string };

const MONTHS: Record<string, number> = {
  JAN: 1, JANUARY: 1, JANUAR: 1, JANV: 1,
  FEB: 2, FEBRUARY: 2, FEBRUAR: 2, FEBR: 2,
  MAR: 3, MARCH: 3, MARTS: 3, MRZ: 3, "MÄRZ": 3, MAERZ: 3,
  APR: 4, APRIL: 4,
  MAY: 5, MAJ: 5, MAI: 5,
  JUN: 6, JUNE: 6, JUNI: 6,
  JUL: 7, JULY: 7, JULI: 7,
  AUG: 8, AUGUST: 8,
  SEP: 9, SEPT: 9, SEPTEMBER: 9,
  OCT: 10, OCTOBER: 10, OKT: 10, OKTOBER: 10,
  NOV: 11, NOVEMBER: 11,
  DEC: 12, DECEMBER: 12, DEZ: 12, DEZEMBER: 12,
};

const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

function valid(g: GDate): GDate | null {
  if (!Number.isInteger(g.y) || g.y < 1 || g.y > 2999) return null;
  if (g.m != null && (g.m < 1 || g.m > 12)) return null;
  if (g.d != null && (g.m == null || g.d < 1 || g.d > daysIn(g.y, g.m))) return null;
  return g;
}

/** Year from "1921" or a dual year "1720/21" (the later, new-style year). */
function year(tok: string): number | null {
  const m = /^(\d{3,4})(?:\/(\d{1,2}))?$/.exec(tok);
  if (!m) return null;
  const y = Number(m[1]);
  if (!m[2]) return y;
  const tail = m[2];
  const base = Math.floor(y / 10 ** tail.length) * 10 ** tail.length;
  const dual = base + Number(tail);
  return dual >= y ? dual : dual + 10 ** tail.length;
}

/** One date without qualifiers. */
export function parseSimple(input: string): GDate | null {
  let s = input.trim().toUpperCase()
    .replace(/@#D[A-Z ]+@/g, " ")
    .replace(/^(GREGORIAN|JULIAN)\s+/, "")
    .replace(/\s+(B\.?C\.?|BCE)$/, " BC")
    .trim();
  if (!s || /\bBC$/.test(s)) return null;
  // ISO 1921-03-03 / 1921-03
  let m = /^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/.exec(s);
  if (m) return valid({ y: +m[1], m: +m[2], ...(m[3] ? { d: +m[3] } : {}) });
  // Numeric day-first: 03.03.1921, 3-3-1921, 3/3/1921 (Danish order)
  m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/.exec(s);
  if (m) return valid({ y: +m[3], m: +m[2], d: +m[1] });
  s = s.replace(/[.,]/g, " ").replace(/\s+/g, " ").trim();
  const toks = s.split(" ");
  if (toks.length === 1) {
    const y = year(toks[0]);
    return y ? valid({ y }) : null;
  }
  if (toks.length === 2) {
    const mo = MONTHS[toks[0]];
    const y = year(toks[1]);
    return mo && y ? valid({ y, m: mo }) : null;
  }
  if (toks.length === 3) {
    const d = /^\d{1,2}$/.test(toks[0]) ? Number(toks[0]) : NaN;
    const mo = MONTHS[toks[1]];
    const y = year(toks[2]);
    return mo && y && d ? valid({ y, m: mo, d }) : null;
  }
  return null;
}

const ABOUT = /^(ABT|ABOUT|CA|CIRCA|C|EST|CAL|OMKRING|OMK|CIRKA|ANSLÅET|BEREGNET|UM)\.?\s+/;
const BEFORE = /^(BEF|BEFORE|FØR|FOER|INDEN|VOR)\.?\s+/;
const AFTER = /^(AFT|AFTER|EFTER|NACH)\.?\s+/;

/** A GEDCOM DATE value. Anything not understood is a phrase (kept as words, never a stored date). */
export function parseDate(raw: string): ParsedDate {
  const text = raw.replace(/\s+/g, " ").trim();
  let s = text.toUpperCase().replace(/@#D[A-Z ]+@/g, " ").replace(/\s+/g, " ").trim();
  if (!s) return { qual: "phrase", raw: text };
  if (/^\(.*\)$/.test(s)) return { qual: "phrase", raw: text };
  s = s.replace(/^INT\.?\s+/, "").replace(/\s*\(.*\)\s*$/, "").trim();

  let m = /^(?:BET|BETWEEN|MELLEM|ZWISCHEN)\.?\s+(.+?)\s+(?:AND|OG|UND|-)\s+(.+)$/.exec(s);
  if (m) {
    const a = parseSimple(m[1]), b = parseSimple(m[2]);
    return a && b ? { qual: "between", a, b, raw: text } : { qual: "phrase", raw: text };
  }
  m = /^(?:FROM|FRA|VON)\s+(.+?)(?:\s+(?:TO|TIL|BIS)\s+(.+))?$/.exec(s);
  if (m) {
    const a = parseSimple(m[1]);
    const b = m[2] ? parseSimple(m[2]) : null;
    if (!a || (m[2] && !b)) return { qual: "phrase", raw: text };
    return b ? { qual: "range", a, b, raw: text } : { qual: "from", a, raw: text };
  }
  m = /^(?:TO|TIL|BIS)\s+(.+)$/.exec(s);
  if (m) {
    const a = parseSimple(m[1]);
    return a ? { qual: "to", a, raw: text } : { qual: "phrase", raw: text };
  }
  for (const [re, qual] of [[ABOUT, "about"], [BEFORE, "before"], [AFTER, "after"]] as const) {
    if (re.test(s)) {
      const a = parseSimple(s.replace(re, ""));
      return a ? { qual, a, raw: text } : { qual: "phrase", raw: text };
    }
  }
  const a = parseSimple(s);
  return a ? { qual: "exact", a, raw: text } : { qual: "phrase", raw: text };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "1921", "1921-03" or "1921-03-03". */
export function isoOf(g: GDate): string {
  return `${String(g.y).padStart(4, "0")}${g.m ? `-${pad(g.m)}` : ""}${g.m && g.d ? `-${pad(g.d)}` : ""}`;
}

/** The full day, only when the file states it exactly. */
export function exactDay(p: ParsedDate | undefined): string | null {
  return p?.qual === "exact" && p.a?.m && p.a.d ? isoOf(p.a) : null;
}

/** The year, only when the file states it exactly (to the year or better). */
export function exactYear(p: ParsedDate | undefined): number | null {
  return p?.qual === "exact" && p.a ? p.a.y : null;
}

/** A year good enough to reason with (living or not, ordering): exact, about, or the middle of a range. */
export function roughYear(p: ParsedDate | undefined): number | null {
  if (!p?.a) return null;
  if (p.b) return Math.round((p.a.y + p.b.y) / 2);
  return p.a.y;
}

function show(g: GDate): string {
  if (g.m && g.d) return `${g.d} ${MONTH_SHORT[g.m - 1]} ${g.y}`;
  if (g.m) return `${MONTH_SHORT[g.m - 1]} ${g.y}`;
  return String(g.y);
}

/** Plain English for the searchable text: "3 Mar 1921", "about 1850", "between 1850 and 1860". */
export function formatDate(p: ParsedDate): string {
  if (!p.a) return p.raw.replace(/^\((.*)\)$/, "$1");
  switch (p.qual) {
    case "exact": return show(p.a);
    case "about": return `about ${show(p.a)}`;
    case "before": return `before ${show(p.a)}`;
    case "after": return `after ${show(p.a)}`;
    case "between": return `between ${show(p.a)} and ${show(p.b!)}`;
    case "range": return `from ${show(p.a)} to ${show(p.b!)}`;
    case "from": return `from ${show(p.a)}`;
    case "to": return `to ${show(p.a)}`;
    default: return p.raw;
  }
}
