import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { chunkSegments } from "../chunk";
import { extractSpreadsheet, formatSheetDate, sniffCsvSeparator } from "./sheet";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function buildWorkbook(): Buffer {
  const wb = XLSX.utils.book_new();
  wb.Props = { Title: "Familiens budget" };

  // Sheet 1: header, numbers, a date, a formula with its cached value, and a merged heading above.
  const budget: XLSX.WorkSheet = {
    "!ref": "A1:D5",
    A1: { t: "s", v: "Budget 2026" },
    A2: { t: "s", v: "Post" }, B2: { t: "s", v: "Beløb" }, C2: { t: "s", v: "Forfald" }, D2: { t: "s", v: "Total" },
    A3: { t: "s", v: "Husleje" }, B3: { t: "n", v: 9500 }, C3: { t: "n", v: 46023, z: "yyyy-mm-dd" }, D3: { t: "n", v: 19000, f: "B3*2" },
    A4: { t: "s", v: "Institution" }, B4: { t: "n", v: 3200.5 }, C4: { t: "n", v: 46054.5, z: "d/m/yyyy h:mm" }, D4: { t: "n", v: 6401, f: "B4*2" },
    A5: { t: "s", v: "Total" }, B5: { t: "n", v: 12700.5, f: "SUM(B3:B4)" },
    "!merges": [{ s: { r: 0, c: 0 }, e: { r: 0, c: 3 } }],
  };
  XLSX.utils.book_append_sheet(wb, budget, "Budget");

  // Sheet 2: numbers only, no header row.
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[1, 2, 3], [4, 5, 6]]), "Tal");

  // Sheet 3: big — 2,500 rows, cut at 2,000.
  const big = [["Nr", "Navn"], ...Array.from({ length: 2500 }, (_, i) => [i + 1, `Række ${i + 1}`])];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(big), "Stor");

  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

describe("spreadsheets", () => {
  it("reads each sheet as a table with a heading, header detection, values of formulas and formatted dates", async () => {
    const ex = await extractSpreadsheet({ bytes: buildWorkbook(), mime: XLSX_MIME, filename: "budget.xlsx" });
    const t = ex.textContent;
    expect(t.startsWith("Spreadsheet: Familiens budget")).toBe(true);
    // The merged title above the table is a caption; the row of labels under it is the header.
    expect(t).toContain("## Sheet: Budget\nBudget 2026\n| Post | Beløb | Forfald | Total |\n| --- | --- | --- | --- |\n| Husleje | 9500 | 2026-01-01 | 19000 |");
    expect(t).toContain("2026-02-01 12:00");
    expect(t).toContain("| Total | 12700.5 |");
    expect(t).not.toContain("SUM(");

    // No header: columns named by letter.
    expect(t).toMatch(/## Sheet: Tal\n\| A \| B \| C \|\n\| --- \| --- \| --- \|\n\| 1 \| 2 \| 3 \|/);

    // Big sheet: cut with a note and a warning.
    expect(t).toContain("## Sheet: Stor\n| Nr | Navn |");
    expect(t).toContain("Række 1999");
    expect(t).not.toContain("Række 2001 ");
    expect(t).toMatch(/Only the first 2,000 rows/);
    expect(ex.warnings.join(" ")).toMatch(/"Stor" is large/);

    expect(ex.meta.documentTitle).toBe("Familiens budget");
    expect(ex.meta.sheets).toEqual(expect.arrayContaining([expect.objectContaining({ name: "Stor", truncated: true, header: true })]));
  });

  it("chunks carry { sheet, range } and repeat the header row", async () => {
    const ex = await extractSpreadsheet({ bytes: buildWorkbook(), mime: XLSX_MIME, filename: "budget.xlsx" });
    const chunks = chunkSegments(ex.segments);
    const budget = chunks.find((c) => c.text.includes("Husleje"));
    expect(budget?.locator).toMatchObject({ sheet: "Budget", range: "A1:D5" });
    const stor = chunks.filter((c) => c.locator.sheet === "Stor");
    expect(stor.length).toBeGreaterThan(10);
    expect(stor[0].locator.range).toMatch(/^A1:B\d+$/);
    expect(stor[1].text).toMatch(/^## Sheet: Stor \(continued\)\n\| Nr \| Navn \|/);
    expect(stor[1].locator.range).toMatch(/^A\d+:B\d+$/);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(1200);
  });

  it("reads a Danish CSV (semicolons, æøå, leading zeros kept)", async () => {
    const csv = "Navn;Telefon;Født\nÅse Ørsted;04512345;2015-03-02\nBo Æbelø;22334455;2017-11-30\n";
    const ex = await extractSpreadsheet({ bytes: Buffer.from(csv, "utf8"), mime: "text/csv", filename: "Klasseliste.csv" });
    expect(ex.textContent).toContain("## Sheet: Klasseliste\n| Navn | Telefon | Født |\n| --- | --- | --- |\n| Åse Ørsted | 04512345 | 2015-03-02 |");
    expect(chunkSegments(ex.segments)[0].locator).toMatchObject({ sheet: "Klasseliste", range: "A1:C3" });
  });

  it("reads old Excel (.xls) and OpenDocument (.ods) too", async () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Navn", "Alder"], ["Ida", 9]]), "Børn");
    for (const [bookType, mime] of [["xls", "application/vnd.ms-excel"], ["ods", "application/vnd.oasis.opendocument.spreadsheet"]] as const) {
      const ex = await extractSpreadsheet({ bytes: XLSX.write(wb, { type: "buffer", bookType }) as Buffer, mime, filename: `b.${bookType}` });
      expect(ex.textContent).toContain("## Sheet: Børn\n| Navn | Alder |\n| --- | --- |\n| Ida | 9 |");
    }
  });

  it("helpers", () => {
    expect(sniffCsvSeparator("a;b;c\n1;2;3")).toBe(";");
    expect(sniffCsvSeparator("a,b\n\"x;y\",2")).toBe(",");
    expect(sniffCsvSeparator("a\tb\n1\t2")).toBe("\t");
    expect(formatSheetDate({ y: 2026, m: 3, d: 4 })).toBe("2026-03-04");
    expect(formatSheetDate({ y: 2026, m: 3, d: 4, H: 8, M: 5 })).toBe("2026-03-04 08:05");
  });

  it("says plainly when a file isn't a spreadsheet", async () => {
    await expect(extractSpreadsheet({ bytes: Buffer.from([0x50, 0x4b, 3, 4, 0, 0, 0]), mime: XLSX_MIME, filename: "x.xlsx" })).rejects.toThrow(/couldn't be opened/);
  });
});
