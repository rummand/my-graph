import { describe, expect, it } from "vitest";
import { documentTitleOf, readableParserError } from "./pipeline";

describe("a broken file says what is wrong in plain words", () => {
  it("never shows the parser's raw message", () => {
    const raw = "error: [xmldom error]\telement parse error: Error: Hierarchy request error: Only one element can be added and only after doctype\n@#[line:undefined,col:undefined]";
    const m = readableParserError(raw, "docx");
    expect(m).toBe("Part of this Word document is damaged, so its text can't be read. Open it, save it again, and add that copy.");
    expect(m).not.toMatch(/undefined|xmldom/);
  });

  it("knows a file that isn't a complete Word document", () => {
    expect(readableParserError("Can't find end of central directory : is this a zip file ? If it is, see https://…", "docx")).toMatch(/^This Word document is damaged or wasn't fully downloaded/);
    expect(readableParserError("End of data reached (data length = 0, asked index = 4). Corrupted zip ?", "pptx")).toMatch(/^This PowerPoint presentation is damaged/);
    expect(readableParserError("Could not find main document part. Are you sure this is a valid .docx file?", "docx")).toMatch(/named like a Word document, but it doesn't contain one/);
    expect(readableParserError("File is encrypted", "spreadsheet")).toMatch(/Excel workbook is protected with a password/);
  });

  it("cleans up anything else", () => {
    expect(readableParserError("Something odd at undefined [line:undefined]", "docx")).toBe("Something odd at");
    expect(readableParserError("undefined", null)).toBe("This file couldn't be read.");
  });
});

describe("PowerPoint and Excel files use the title they give themselves", () => {
  it("prefers meta.documentTitle over the file name", () => {
    expect(documentTitleOf({ documentTitle: "  Skoleåret  2026 " }, "deck-final-v3.pptx")).toBe("Skoleåret 2026");
    expect(documentTitleOf({ documentTitle: "" }, "budget.xlsx")).toBe("budget.xlsx");
    expect(documentTitleOf({}, "budget.xlsx")).toBe("budget.xlsx");
    expect(documentTitleOf({ documentTitle: 42 }, "budget.xlsx")).toBe("budget.xlsx");
  });
});
