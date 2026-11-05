/**
 * Reading GEDCOM 5.5 / 5.5.1 / 7.0 into people and families (pure). Lines are `level [@xref@] TAG [value]`; CONT
 * starts a new line of the value above, CONC continues it. Unknown and vendor tags (`_UID`, `_MARNM`, `RIN`, Geni's and
 * Ancestry's extras) are read where they help and ignored otherwise; a broken line never stops the file.
 */
import { parseDate, type ParsedDate } from "./dates";

export type GLine = { level: number; xref: string | null; tag: string; value: string; line: number; children: GLine[] };

export type GEvent = { tag: string; date?: ParsedDate; place?: string; note?: string; sources: string[]; value?: string; type?: string };

export type GName = { full: string; given: string; surname: string; type?: string; nick?: string; married?: string[] };

export type GIndi = {
  xref: string;
  names: GName[];
  sex?: "male" | "female";
  events: GEvent[];
  occupations: string[];
  notes: string[];
  sources: string[];
  uid?: string;
  rin?: string;
  /** RESN: confidential | privacy | locked. */
  restriction?: string;
  famc: { fam: string; pedigree?: string }[];
  fams: string[];
  lineFrom: number;
  lineTo: number;
};

export type GFam = {
  xref: string;
  husb?: string;
  wife?: string;
  children: { indi: string; pedigree?: string }[];
  events: GEvent[];
  notes: string[];
  sources: string[];
  lineFrom: number;
  lineTo: number;
};

export type GHeader = { version?: string; product?: string; charset?: string; date?: ParsedDate; language?: string };

export type GedcomFile = { header: GHeader; indis: GIndi[]; fams: GFam[]; lines: number; badLines: number };

const LINE = /^\s*(\d{1,2})\s+(?:(@[^@\s][^@]*@)\s+)?([A-Za-z0-9_]+)(?:[ \t](.*))?$/;

/** All lines as a tree of records (level 0) with their substructures. CONT/CONC are folded into the values. */
export function parseLines(text: string): { records: GLine[]; lines: number; badLines: number } {
  const raw = text.split(/\r\n|\r|\n/);
  const records: GLine[] = [];
  const stack: GLine[] = [];
  let badLines = 0;
  for (let i = 0; i < raw.length; i++) {
    const s = raw[i].replace(/^﻿/, "");
    if (!s.trim()) continue;
    const m = LINE.exec(s);
    if (!m) {
      // Some programs wrap long notes without CONT: treat the line as more of the value above.
      const top = stack[stack.length - 1];
      if (top) top.value += `\n${s.trim()}`;
      else badLines++;
      continue;
    }
    const level = Number(m[1]);
    const tag = m[3].toUpperCase();
    let value = m[4] ?? "";
    if (value.startsWith("@@")) value = value.slice(1); // GEDCOM 7 escape
    value = value.replace(/@@/g, "@"); // GEDCOM 5.5 escape in text
    if (tag === "CONT" || tag === "CONC") {
      const parent = stack[level - 1];
      if (parent) parent.value += (tag === "CONT" ? "\n" : "") + value;
      else badLines++;
      continue;
    }
    const node: GLine = { level, xref: m[2] ?? null, tag, value, line: i + 1, children: [] };
    if (level === 0) {
      records.push(node);
      stack.length = 0;
      stack[0] = node;
      continue;
    }
    const parent = stack[level - 1];
    if (!parent) { badLines++; continue; }
    parent.children.push(node);
    stack.length = level;
    stack[level] = node;
  }
  return { records, lines: raw.length, badLines };
}

const first = (l: GLine, tag: string) => l.children.find((c) => c.tag === tag);
const all = (l: GLine, tag: string) => l.children.filter((c) => c.tag === tag);
const lastLine = (l: GLine): number => (l.children.length ? lastLine(l.children[l.children.length - 1]) : l.line);
const isPointer = (v: string) => /^@[^@]+@$/.test(v.trim());
const clean = (s: string) => s.replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();

/** Title-case a surname some programs write in capitals (HANSEN → Hansen), leaving mixed case alone. */
function uncap(s: string): string {
  if (!/\p{Lu}{2,}/u.test(s) || /\p{Ll}/u.test(s)) return s;
  return s.toLowerCase().replace(/(^|[\s\-'’])(\p{L})/gu, (_, a: string, b: string) => a + b.toUpperCase());
}

function parseName(l: GLine): GName | null {
  const v = l.value.trim();
  const m = /^([^/]*)\/([^/]*)\/?(.*)$/.exec(v);
  let given = (first(l, "GIVN")?.value ?? (m ? m[1] : v)).trim();
  let surname = uncap((first(l, "SURN")?.value ?? (m ? m[2] : "")).trim());
  const suffix = (first(l, "NSFX")?.value ?? (m ? m[3] : "")).trim();
  // NAME with no slashes but GIVN/SURN parts
  if (!m && first(l, "SURN") && !first(l, "GIVN") && v.endsWith(surname)) given = v.slice(0, v.length - surname.length).trim();
  given = given.replace(/\s+/g, " ");
  surname = surname.replace(/\s+/g, " ").replace(/,/g, " ").trim();
  const full = [given, surname, suffix].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  if (!full) return null;
  const married = [...all(l, "_MARNM"), ...all(l, "_MARN")].map((c) => uncap(c.value.replace(/\//g, "").trim())).filter(Boolean);
  return {
    full, given, surname,
    type: first(l, "TYPE")?.value.trim().toLowerCase() || undefined,
    nick: first(l, "NICK")?.value.trim() || undefined,
    married: married.length ? married : undefined,
  };
}

type Lookup = { notes: Map<string, string>; sources: Map<string, string> };

function noteText(l: GLine, lk: Lookup): string {
  const v = l.value.trim();
  if (isPointer(v)) return lk.notes.get(v) ?? "";
  return clean(l.value);
}

function citation(l: GLine, lk: Lookup): string {
  const v = l.value.trim();
  const title = isPointer(v) ? lk.sources.get(v) ?? "" : clean(l.value);
  const page = first(l, "PAGE")?.value.trim();
  const text = first(l, "DATA") && first(first(l, "DATA")!, "TEXT")?.value.trim();
  return [title, page, text ? `“${clean(text)}”` : ""].filter(Boolean).join(", ").slice(0, 400);
}

function placeOf(l: GLine): string | undefined {
  const p = first(l, "PLAC");
  if (!p) {
    const addr = first(l, "ADDR");
    const city = addr && first(addr, "CITY")?.value.trim();
    return city || undefined;
  }
  const s = p.value.split(",").map((x) => x.trim()).filter(Boolean).join(", ");
  return s || undefined;
}

function event(l: GLine, lk: Lookup): GEvent {
  const date = first(l, "DATE");
  const phrase = date && first(date, "PHRASE")?.value; // GEDCOM 7
  return {
    tag: l.tag,
    date: date?.value.trim() ? parseDate(date.value) : phrase ? parseDate(`(${phrase})`) : undefined,
    place: placeOf(l),
    note: all(l, "NOTE").map((n) => noteText(n, lk)).filter(Boolean).join(" ") || undefined,
    sources: all(l, "SOUR").map((s) => citation(s, lk)).filter(Boolean),
    value: l.value.trim() || undefined,
    type: first(l, "TYPE")?.value.trim() || undefined,
  };
}

const INDI_EVENTS = new Set(["BIRT", "CHR", "BAPM", "DEAT", "BURI", "CREM", "RESI", "EMIG", "IMMI", "CONF", "GRAD", "RETI", "EVEN", "CENS", "PROB", "WILL", "NATU"]);
const FAM_EVENTS = new Set(["MARR", "DIV", "ENGA", "MARB", "MARL", "MARS", "ANUL", "DIVF", "EVEN"]);

export function parseGedcom(text: string): GedcomFile {
  const { records, lines, badLines } = parseLines(text);
  const lk: Lookup = { notes: new Map(), sources: new Map() };
  for (const r of records) {
    if (!r.xref) continue;
    if (r.tag === "NOTE" || r.tag === "SNOTE") lk.notes.set(r.xref, clean(r.value));
    if (r.tag === "SOUR") {
      const t = first(r, "TITL")?.value || first(r, "ABBR")?.value || first(r, "AUTH")?.value || r.value;
      lk.sources.set(r.xref, clean(t ?? "").slice(0, 300));
    }
  }

  const header: GHeader = {};
  const head = records.find((r) => r.tag === "HEAD");
  if (head) {
    const gedc = first(head, "GEDC");
    header.version = gedc && first(gedc, "VERS")?.value.trim();
    const sour = first(head, "SOUR");
    header.product = sour ? (first(sour, "NAME")?.value.trim() || sour.value.trim()) : undefined;
    header.charset = first(head, "CHAR")?.value.trim();
    const d = first(head, "DATE");
    header.date = d?.value.trim() ? parseDate(d.value) : undefined;
    header.language = first(head, "LANG")?.value.trim();
  }

  const indis: GIndi[] = [];
  const fams: GFam[] = [];
  for (const r of records) {
    if (r.tag === "INDI" && r.xref) {
      const names = all(r, "NAME").map(parseName).filter((n): n is GName => !!n);
      const sex = first(r, "SEX")?.value.trim().toUpperCase();
      indis.push({
        xref: r.xref,
        names,
        sex: sex === "M" ? "male" : sex === "F" ? "female" : undefined,
        events: r.children.filter((c) => INDI_EVENTS.has(c.tag)).map((c) => event(c, lk)),
        occupations: all(r, "OCCU").map((o) => clean(o.value)).filter(Boolean),
        notes: all(r, "NOTE").map((n) => noteText(n, lk)).filter(Boolean),
        sources: all(r, "SOUR").map((s) => citation(s, lk)).filter(Boolean),
        uid: (first(r, "_UID")?.value || first(r, "UID")?.value || first(r, "_GUID")?.value)?.trim() || undefined,
        rin: first(r, "RIN")?.value.trim() || undefined,
        restriction: first(r, "RESN")?.value.trim().toLowerCase() || undefined,
        famc: all(r, "FAMC").filter((f) => isPointer(f.value)).map((f) => ({ fam: f.value.trim(), pedigree: first(f, "PEDI")?.value.trim().toLowerCase() || undefined })),
        fams: all(r, "FAMS").filter((f) => isPointer(f.value)).map((f) => f.value.trim()),
        lineFrom: r.line,
        lineTo: lastLine(r),
      });
    } else if (r.tag === "FAM" && r.xref) {
      const ptr = (tag: string) => {
        const v = first(r, tag)?.value.trim();
        return v && isPointer(v) && v !== "@VOID@" ? v : undefined;
      };
      fams.push({
        xref: r.xref,
        husb: ptr("HUSB"),
        wife: ptr("WIFE"),
        children: all(r, "CHIL").filter((c) => isPointer(c.value) && c.value.trim() !== "@VOID@")
          .map((c) => ({ indi: c.value.trim(), pedigree: (first(c, "_FREL") || first(c, "_MREL") || first(c, "PEDI"))?.value.trim().toLowerCase() || undefined })),
        events: r.children.filter((c) => FAM_EVENTS.has(c.tag)).map((c) => event(c, lk)),
        notes: all(r, "NOTE").map((n) => noteText(n, lk)).filter(Boolean),
        sources: all(r, "SOUR").map((s) => citation(s, lk)).filter(Boolean),
        lineFrom: r.line,
        lineTo: lastLine(r),
      });
    }
  }

  // Families named only from the people's side (FAMC without a CHIL, FAMS without HUSB/WIFE).
  const famBy = new Map(fams.map((f) => [f.xref, f]));
  for (const p of indis) {
    for (const c of p.famc) {
      const f = famBy.get(c.fam);
      if (f && !f.children.some((x) => x.indi === p.xref)) f.children.push({ indi: p.xref, pedigree: c.pedigree });
    }
    for (const fx of p.fams) {
      const f = famBy.get(fx);
      if (!f || f.husb === p.xref || f.wife === p.xref) continue;
      if (!f.husb && p.sex !== "female") f.husb = p.xref;
      else if (!f.wife) f.wife = p.xref;
    }
  }
  return { header, indis, fams, lines, badLines };
}
