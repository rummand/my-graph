import { describe, expect, it } from "vitest";
import { contentKeyOf, nameKeyOf, officeDocKey, pdfDocKey, textSimilarity } from "./revisions";

const enc = (s: string) => new TextEncoder().encode(s);

/** A stored (uncompressed) zip with the given files. */
function zip(files: Record<string, string>): Uint8Array {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text, "utf8");
    const n = Buffer.from(name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(n.length, 26);
    parts.push(local, n, data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(n.length, 28); c.writeUInt32LE(offset, 42);
    central.push(c, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...parts, cd, end]));
}

describe("which document a file is", () => {
  it("reads a PDF's permanent id, preferring XMP's DocumentID", () => {
    const a = enc("%PDF-1.7\n…trailer << /ID [<0A1B2C3D4E5F60718293A4B5C6D7E8F9><FFFFEEEEDDDDCCCCBBBBAAAA99998888>] >>");
    const b = enc("%PDF-1.7\n…trailer << /ID [<0a1b2c3d4e5f60718293a4b5c6d7e8f9><1111222233334444555566667777AAAA>] >>");
    expect(pdfDocKey(a)).toBe(pdfDocKey(b)); // re-saved: the second half changes, the first doesn't
    expect(pdfDocKey(enc('<x:xmpmeta><rdf:Description xmpMM:DocumentID="uuid:5D2F1A9C-0B4E-4C1F-9E0A-AB12CD34EF56"/>…/ID [<0A1B2C3D4E5F60718293A4B5C6D7E8F9><00>]')))
      .toBe("pdf:xmp:5d2f1a9c-0b4e-4c1f-9e0a-ab12cd34ef56");
    expect(pdfDocKey(enc("%PDF-1.4 no id here"))).toBeNull();
    expect(pdfDocKey(enc("/ID [<00000000000000000000000000000000><00>]"))).toBeNull();
  });

  it("reads an Office file's creation stamp and author", () => {
    const core = (created: string, title = "x") => zip({ "docProps/core.xml": `<cp:coreProperties><dc:title>${title}</dc:title><dc:creator>Anna Hansen</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${created}</dcterms:created></cp:coreProperties>` });
    expect(officeDocKey(core("2024-03-01T09:00:00Z"), "docx")).toBe("office:docx:2024-03-01T09:00:00Z|anna hansen");
    expect(officeDocKey(core("2024-03-01T09:00:00Z", "changed title"), "docx")).toBe(officeDocKey(core("2024-03-01T09:00:00Z"), "docx"));
    expect(officeDocKey(core("2024-03-02T09:00:00Z"), "docx")).not.toBe(officeDocKey(core("2024-03-01T09:00:00Z"), "docx"));
    expect(officeDocKey(zip({ "word/document.xml": "<w/>" }), "docx")).toBeNull();
  });

  it("takes the version words off a file name", () => {
    expect(nameKeyOf("Lejekontrakt v3 (1).pdf", "pdf")).toBe("lejekontrakt.pdf");
    expect(nameKeyOf("Lejekontrakt FINAL.pdf", "pdf")).toBe("lejekontrakt.pdf");
    expect(nameKeyOf("lejekontrakt_endelig_kopi.pdf", "pdf")).toBe("lejekontrakt.pdf");
    expect(nameKeyOf("ADR-012 Storage v2.docx", "docx")).toBe("adr 012 storage.docx");
    expect(nameKeyOf("ADR-012 Storage v2.docx", "docx")).not.toBe(nameKeyOf("ADR-012 Storage v2.pdf", "pdf"));
    expect(nameKeyOf("Budget 2025.xlsx", "spreadsheet")).toBe("budget 2025.xlsx"); // a year is not a version
  });

  it("never matches on names everyone has", () => {
    expect(nameKeyOf("Scan 0001.pdf", "pdf")).toBeNull();
    expect(nameKeyOf("document (3).pdf", "pdf")).toBeNull();
    expect(nameKeyOf("IMG_4521.jpg", "image")).toBeNull();
    expect(nameKeyOf("Untitled.docx", "docx")).toBeNull();
  });

  it("hashes text so whitespace and case don't matter, and ignores almost-empty text", () => {
    const t = "Lejekontrakt for Vestergade 12, 7100 Vejle. Huslejen er 8.500 kr. om måneden.";
    expect(contentKeyOf(t)).toBe(contentKeyOf(`  ${t.toUpperCase().replace(/ /g, "\n ")}  `));
    expect(contentKeyOf("kort")).toBeNull();
  });

  it("tells a revised document from a different one", () => {
    const base = Array.from({ length: 60 }, (_, i) => `Afsnit ${i}: lejer betaler husleje forud den første i måneden og vedligeholder boligen indvendigt.`).join(" ");
    const revised = base.replace("Afsnit 7:", "Afsnit 7 (rettet):").replace("Afsnit 30:", "Afsnit 30 (ny tekst om husdyr):");
    expect(textSimilarity(base, revised)).toBeGreaterThan(0.8);
    expect(textSimilarity(base, "Referat af forældremøde i 3.B. Vi talte om lejrskole, madordning og trivsel i klassen.")).toBeLessThan(0.05);
  });
});
