import { describe, expect, it } from "vitest";
import { checkStatedDate, findTextDates, letterDate, parsePdfDate, pickDocumentDate, type DateCandidate } from "./document-date";

const now = new Date("2026-11-04T12:00:00Z");
const c = (origin: DateCandidate["origin"], iso: string, precision: DateCandidate["precision"] = "day"): DateCandidate => ({ origin, at: new Date(iso), precision });

describe("pickDocumentDate precedence", () => {
  it("email header beats EXIF beats the stated date beats the letterhead beats PDF metadata beats the parent email", () => {
    const all = [c("parent", "2024-01-06"), c("pdf", "2024-01-05"), c("text", "2024-01-04"), c("model", "2024-01-03"), c("exif", "2024-01-02"), c("email", "2024-01-01")];
    expect(pickDocumentDate(all, now)?.origin).toBe("email");
    expect(pickDocumentDate(all.filter((x) => x.origin !== "email"), now)?.origin).toBe("exif");
    expect(pickDocumentDate(all.filter((x) => !["email", "exif"].includes(x.origin)), now)?.origin).toBe("model");
    expect(pickDocumentDate([c("pdf", "2024-01-05"), c("text", "2024-01-04")], now)?.origin).toBe("text");
    expect(pickDocumentDate([c("parent", "2024-01-06"), c("pdf", "2024-01-05")], now)?.origin).toBe("pdf");
  });
  it("ignores implausible dates and returns null for nothing", () => {
    expect(pickDocumentDate([c("email", "1601-01-01"), c("pdf", "2031-01-01")], now)).toBeNull();
    expect(pickDocumentDate([c("email", "1601-01-01"), c("text", "2025-03-03")], now)?.origin).toBe("text");
    expect(pickDocumentDate([], now)).toBeNull();
  });
  it("prefers the more exact date from the same reader", () => {
    expect(pickDocumentDate([c("model", "2024-03-01", "month"), c("model", "2024-03-03", "day")], now)?.precision).toBe("day");
  });
});

describe("dates in text", () => {
  it("reads Danish and English formats", () => {
    const iso = (t: string) => findTextDates(t).map((d) => d.at.toISOString().slice(0, 10));
    expect(iso("København, 3. marts 2024")).toEqual(["2024-03-03"]);
    expect(iso("Dato: 03.03.2024")).toEqual(["2024-03-03"]);
    expect(iso("3/3-2024")).toEqual(["2024-03-03"]);
    expect(iso("March 3, 2024")).toEqual(["2024-03-03"]);
    expect(iso("3 March 2024")).toEqual(["2024-03-03"]);
    expect(iso("2024-03-03")).toEqual(["2024-03-03"]);
    expect(findTextDates("i september 2025")[0]?.precision).toBe("month");
    expect(iso("31.02.2024")).toEqual([]);
  });
  it("takes the letter's own date from a Dato line or the letterhead, not dates further down", () => {
    expect(letterDate("Skolen\nDato: 1. oktober 2026\n\nTuren er 14. oktober 2026.", now)?.at.toISOString().slice(0, 10)).toBe("2026-10-01");
    const far = `Kære forældre\n${"x ".repeat(400)}\nTuren er den 14. oktober 2026.`;
    expect(letterDate(far, now)).toBeNull();
    expect(letterDate("Skolen ved Søerne\nKøbenhavn, 3. marts 2024\n\nKære forældre", now)?.at.toISOString().slice(0, 10)).toBe("2024-03-03");
    expect(letterDate("Brev\nTorsdag den 3. marts 2024\nHej", now)?.quote).toBe("Torsdag den 3. marts 2024");
  });
  it("does not take a date from a sentence or an appointment's Date line", () => {
    expect(letterDate("Dear parents,\nEmma's class will go on a field trip on Thursday 19 November 2026.\n", now)).toBeNull();
    expect(letterDate("Appointment confirmation\nDate: Wednesday 2 December 2026 at 15:15\n", now)).toBeNull();
  });
});

describe("PDF dates", () => {
  it("parses D:YYYYMMDDHHmmSS with offsets", () => {
    expect(parsePdfDate("D:20240303120000+01'00'")?.toISOString()).toBe("2024-03-03T11:00:00.000Z");
    expect(parsePdfDate("D:2024")?.toISOString()).toBe("2024-01-01T00:00:00.000Z");
    expect(parsePdfDate("nonsense")).toBeNull();
  });
});

describe("checkStatedDate", () => {
  const text = "Skolen\nKøbenhavn, 1. oktober 2026\nKære forældre";
  it("keeps a model date backed by a quote from the text", () => {
    expect(checkStatedDate({ at: new Date("2026-10-01"), precision: "day", quote: "København, 1. oktober 2026" }, text, now)?.origin).toBe("model");
  });
  it("drops a date with no quote, a quote not in the text, or a quote holding another date", () => {
    expect(checkStatedDate({ at: new Date("2026-11-04"), precision: "day" }, text, now)).toBeNull();
    expect(checkStatedDate({ at: new Date("2026-11-04"), precision: "day", quote: "4. november 2026" }, text, now)).toBeNull();
    expect(checkStatedDate({ at: new Date("2026-11-04"), precision: "day", quote: "København, 1. oktober 2026" }, text, now)).toBeNull();
  });
});
