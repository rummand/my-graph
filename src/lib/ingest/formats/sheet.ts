/**
 * Spreadsheets: Excel (.xlsx, .xlsm, .xls), OpenDocument (.ods) and CSV, through SheetJS. Each sheet becomes a
 * heading and a markdown-style table: the first row is the header when it looks like one (all labels), otherwise
 * columns are named by their letters. Formulas are read as their last calculated values, dates are written as
 * yyyy-mm-dd (with the time when there is one), and a merged cell's value fills the whole merged area. Very large
 * sheets are cut off with a note. Locator per chunk: { sheet, range }. Pure apart from parsing the bytes.
 */
import type { TextSegment } from "../chunk";
import { decodeText } from "./text";
import type { ExtractedText } from "./types";

type XLSXModule = typeof import("xlsx");
type WorkBook = import("xlsx").WorkBook;
type WorkSheet = import("xlsx").WorkSheet;
type CellObject = import("xlsx").CellObject;

export const MAX_SHEET_ROWS = 2000;
export const MAX_SHEET_COLS = 60;
const MAX_SHEETS = 50;
const MAX_CELL_CHARS = 300;
const MAX_TOTAL_CHARS = 600_000;
/** Each chunk of a table stays under this, with its header repeated, so a chunk is one readable piece. */
const SEGMENT_CHARS = 1100;

type Kind = "s" | "n" | "d" | "b" | "e" | "";
type Grid = { rows: { r: number; cells: string[]; kinds: Kind[] }[]; cols: number[] };

export type SheetSection = {
  name: string;
  hidden: boolean;
  header: string[] | null;
  /** Zero-based row number of the header row. */
  headerRow: number | null;
  /** Title lines above the table (a merged "Budget 2026" across the top). */
  captions: string[];
  /** Zero-based number of the first row read (caption or header or data). */
  topRow: number;
  /** Column letters of the kept columns. */
  columns: string[];
  rows: { r: number; cells: string[] }[];
  totalRows: number;
  truncated: boolean;
};

const pad2 = (n: number) => String(n).padStart(2, "0");

/** A spreadsheet date as people read it: 2025-03-14, or 2025-03-14 08:30. */
export function formatSheetDate(p: { y: number; m: number; d: number; H?: number; M?: number; S?: number }, withDate = true): string {
  const date = `${p.y}-${pad2(p.m)}-${pad2(p.d)}`;
  const hasTime = (p.H ?? 0) || (p.M ?? 0) || (p.S ?? 0);
  const time = `${pad2(p.H ?? 0)}:${pad2(p.M ?? 0)}${p.S ? `:${pad2(p.S)}` : ""}`;
  if (!withDate) return time;
  return hasTime ? `${date} ${time}` : date;
}

const clean = (s: string) => {
  const t = s.replace(/\s*[\r\n]+\s*/g, " / ").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
  return t.length > MAX_CELL_CHARS ? `${t.slice(0, MAX_CELL_CHARS - 1)}…` : t;
};

function cellValue(X: XLSXModule, c: CellObject | undefined): { text: string; kind: Kind } {
  if (!c || c.t === "z" || c.v === undefined || c.v === null) return { text: c?.w ? clean(c.w) : "", kind: "" };
  switch (c.t) {
    case "b": return { text: c.v ? "TRUE" : "FALSE", kind: "b" };
    case "e": return { text: c.w ?? "#ERROR", kind: "e" };
    case "d": {
      const d = c.v instanceof Date ? c.v : new Date(String(c.v));
      if (Number.isNaN(d.getTime())) return { text: clean(String(c.v)), kind: "s" };
      return { text: formatSheetDate({ y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), H: d.getUTCHours(), M: d.getUTCMinutes(), S: d.getUTCSeconds() }), kind: "d" };
    }
    case "n": {
      const fmt = typeof c.z === "string" ? c.z : undefined;
      if (fmt && X.SSF.is_date(fmt) && typeof c.v === "number") {
        const p = X.SSF.parse_date_code(c.v) as { y: number; m: number; d: number; H: number; M: number; S: number } | null;
        // A value under 1 is a time of day only (its "date" would be 1899-12-31).
        if (p) return { text: formatSheetDate(p, c.v >= 1), kind: "d" };
      }
      return { text: clean(c.w ?? String(c.v)), kind: "n" };
    }
    default: return { text: clean(c.w ?? String(c.v)), kind: "s" };
  }
}

/** The cells of a sheet as text, merged areas filled, empty rows and columns dropped. */
function sheetGrid(X: XLSXModule, ws: WorkSheet): { grid: Grid; totalRows: number; truncated: boolean } {
  const empty = { grid: { rows: [], cols: [] }, totalRows: 0, truncated: false };
  const ref = ws["!ref"];
  if (!ref) return empty;
  const range = X.utils.decode_range(ref);
  const full = ws["!fullref"] ? X.utils.decode_range(ws["!fullref"]) : range;
  const lastRow = Math.min(range.e.r, range.s.r + MAX_SHEET_ROWS - 1);
  const lastCol = Math.min(range.e.c, range.s.c + MAX_SHEET_COLS - 1);
  const dense = (ws as { "!data"?: CellObject[][] })["!data"];
  const get = (r: number, c: number): CellObject | undefined => (dense ? dense[r]?.[c] : (ws[X.utils.encode_cell({ r, c })] as CellObject | undefined));

  const width = lastCol - range.s.c + 1;
  const rows: Grid["rows"] = [];
  const byRow = new Map<number, Grid["rows"][number]>();
  for (let r = range.s.r; r <= lastRow; r++) {
    const cells: string[] = new Array(width).fill("");
    const kinds: Kind[] = new Array(width).fill("");
    for (let c = range.s.c; c <= lastCol; c++) {
      const v = cellValue(X, get(r, c));
      cells[c - range.s.c] = v.text;
      kinds[c - range.s.c] = v.kind;
    }
    const row = { r, cells, kinds };
    rows.push(row);
    byRow.set(r, row);
  }
  // A merged cell's value belongs to every cell it covers (a heading over three columns, a group label down a column).
  for (const m of ws["!merges"] ?? []) {
    const src = byRow.get(m.s.r);
    const ci = m.s.c - range.s.c;
    if (!src || ci < 0 || ci >= width || !src.cells[ci]) continue;
    for (let r = m.s.r; r <= Math.min(m.e.r, lastRow); r++) {
      const row = byRow.get(r);
      if (!row) continue;
      for (let c = m.s.c; c <= Math.min(m.e.c, lastCol); c++) {
        const k = c - range.s.c;
        if (k >= 0 && k < width && !row.cells[k]) { row.cells[k] = src.cells[ci]; row.kinds[k] = src.kinds[ci]; }
      }
    }
  }
  const kept = rows.filter((row) => row.cells.some(Boolean));
  const cols = Array.from({ length: width }, (_, i) => i).filter((i) => kept.some((row) => row.cells[i]));
  return {
    grid: { rows: kept.map((row) => ({ r: row.r, cells: cols.map((i) => row.cells[i]), kinds: cols.map((i) => row.kinds[i]) })), cols: cols.map((i) => i + range.s.c) },
    totalRows: full.e.r - full.s.r + 1,
    truncated: full.e.r > lastRow || full.e.c > lastCol,
  };
}

/** The first row is a header when it is all labels (no numbers or dates), mostly filled, and not all alike. */
export function looksLikeHeader(first: { cells: string[]; kinds: Kind[] }, rest: { kinds: Kind[] }[]): boolean {
  if (!rest.length) return false;
  const filled = first.cells.filter(Boolean);
  if (filled.length < Math.max(1, Math.ceil(first.cells.length * 0.5))) return false;
  if (first.kinds.some((k) => k && k !== "s")) return false;
  if (new Set(filled.map((s) => s.toLowerCase())).size !== filled.length) return false;
  if (filled.some((s) => s.length > 80)) return false;
  // Below a header there is usually something other than labels; a sheet of words only still has a header if it is short.
  return rest.some((row) => row.kinds.some((k) => k && k !== "s")) || filled.every((s) => s.length <= 40);
}

export function sheetSections(X: XLSXModule, wb: WorkBook): SheetSection[] {
  const out: SheetSection[] = [];
  const info = wb.Workbook?.Sheets ?? [];
  for (const [i, name] of wb.SheetNames.slice(0, MAX_SHEETS).entries()) {
    const ws = wb.Sheets[name];
    if (!ws) continue;
    const { grid, totalRows, truncated } = sheetGrid(X, ws);
    if (!grid.rows.length) continue;
    const columns = grid.cols.map((c) => X.utils.encode_col(c));
    // Rows at the top holding a single value (a title, often merged across the table) are captions, not data.
    let rows = grid.rows;
    const captions: string[] = [];
    while (rows.length > 1 && grid.cols.length > 1 && captions.length < 3 && new Set(rows[0].cells.filter(Boolean)).size === 1) {
      captions.push(rows[0].cells.find(Boolean)!);
      rows = rows.slice(1);
    }
    const header = looksLikeHeader(rows[0], rows.slice(1)) ? rows[0].cells : null;
    out.push({
      name,
      hidden: !!info[i]?.Hidden,
      header,
      headerRow: header ? rows[0].r : null,
      captions,
      topRow: grid.rows[0].r,
      columns,
      rows: (header ? rows.slice(1) : rows).map((r) => ({ r: r.r, cells: r.cells })),
      totalRows,
      truncated,
    });
  }
  return out;
}

const tableRow = (cells: string[]) => `| ${cells.join(" | ")} |`;

function headerLines(s: SheetSection): string[] {
  const h = s.header ?? s.columns;
  return [tableRow(h.map((c, i) => c || s.columns[i])), `|${" --- |".repeat(h.length)}`];
}

const heading = (s: SheetSection, more = false) =>
  [`## Sheet: ${s.name}${s.hidden ? " (hidden)" : ""}${more ? " (continued)" : ""}`, ...s.captions].join("\n");

/** Spreadsheet cut into segments with { sheet, range } locators, plus the whole text. */
export function sectionsToText(sections: SheetSection[], title?: string | null): { segments: TextSegment[]; textContent: string; warnings: string[]; cut: boolean } {
  const segments: TextSegment[] = [];
  const full: string[] = [];
  const warnings: string[] = [];
  let total = 0;
  let cut = false;
  if (title) full.push(`Spreadsheet: ${title}`);
  for (const s of sections) {
    if (total > MAX_TOTAL_CHARS) { cut = true; break; }
    const head = headerLines(s);
    const headerRow = s.headerRow;
    const lastCol = s.columns[s.columns.length - 1];
    const note = s.truncated ? `(Only the first ${MAX_SHEET_ROWS.toLocaleString("en")} rows and ${MAX_SHEET_COLS} columns were read; the sheet has ${s.totalRows.toLocaleString("en")} rows.)` : "";
    if (s.truncated) warnings.push(`The sheet "${s.name}" is large; only its first ${MAX_SHEET_ROWS.toLocaleString("en")} rows were read.`);
    const lines = s.rows.map((r) => tableRow(r.cells));
    full.push([heading(s), ...head, ...lines, ...(note ? [note] : [])].join("\n"));
    total += full[full.length - 1].length;

    // Segments: the heading and header row repeated on each, rows packed up to SEGMENT_CHARS.
    let i = 0;
    let first = true;
    if (!lines.length) {
      segments.push({ text: [heading(s), ...head].join("\n"), at: { sheet: s.name, range: `${s.columns[0]}${s.topRow + 1}:${lastCol}${(headerRow ?? s.topRow) + 1}` } });
      continue;
    }
    while (i < lines.length) {
      const top = [...(first && title && segments.length === 0 ? [`Spreadsheet: ${title}`] : []), heading(s, !first), ...head];
      let len = top.join("\n").length;
      const start = i;
      while (i < lines.length && (i === start || len + lines[i].length + 1 <= SEGMENT_CHARS)) len += lines[i++].length + 1;
      const fromRow = first ? s.topRow : s.rows[start].r;
      const toRow = s.rows[i - 1].r;
      const tail = i >= lines.length && note ? [note] : [];
      segments.push({ text: [...top, ...lines.slice(start, i), ...tail].join("\n"), at: { sheet: s.name, range: `${s.columns[0]}${fromRow + 1}:${lastCol}${toRow + 1}` } });
      first = false;
    }
  }
  if (cut) {
    warnings.push("The spreadsheet is very large; only the first part of it was read.");
    full.push("(The rest of the spreadsheet wasn't read: it is too large.)");
  }
  return { segments, textContent: full.join("\n\n"), warnings, cut };
}

/** The separator a CSV uses: comma, semicolon (Danish Excel) or tab, by counting outside quotes in the first lines. */
export function sniffCsvSeparator(text: string): string {
  const sample = text.split(/\r?\n/).slice(0, 10).join("\n").replace(/"[^"]*"/g, "");
  const counts = [",", ";", "\t"].map((c) => [c, sample.split(c).length - 1] as const);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ",";
}

export async function extractSpreadsheet(opts: { bytes: Buffer; mime: string; filename: string }): Promise<ExtractedText> {
  const X = (await import("xlsx")) as XLSXModule;
  let wb: WorkBook;
  try {
    if (opts.mime === "text/csv") {
      const text = decodeText(opts.bytes);
      // Values as written: a CSV has no types, and guessing would turn phone numbers and ids into numbers.
      wb = X.read(text, { type: "string", raw: true, FS: sniffCsvSeparator(text), sheetRows: MAX_SHEET_ROWS + 1, dense: true });
    } else {
      wb = X.read(opts.bytes, { type: "buffer", cellNF: true, cellDates: false, cellHTML: false, cellFormula: false, sheetRows: MAX_SHEET_ROWS + 1, dense: true });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/password|encrypt/i.test(msg)) throw new Error("This spreadsheet is protected with a password. Remove the password, save it and upload it again.");
    throw new Error("This spreadsheet couldn't be opened. It may be damaged or in a format the library doesn't read.");
  }
  const sections = sheetSections(X, wb);
  // A CSV has one unnamed sheet: call it by the file's name.
  if (opts.mime === "text/csv" && sections[0]) sections[0].name = opts.filename.replace(/\.csv$/i, "");
  const title = typeof wb.Props?.Title === "string" && wb.Props.Title.trim() ? wb.Props.Title.trim() : null;
  const { segments, textContent, warnings } = sectionsToText(sections, title);
  if (!sections.length) warnings.push("The spreadsheet has no filled-in cells.");
  return {
    segments,
    textContent,
    meta: {
      documentTitle: title,
      sheets: sections.map((s) => ({ name: s.name, rows: s.totalRows, columns: s.columns.length, header: !!s.header, truncated: s.truncated })),
    },
    warnings,
    activity: "upload",
  };
}
