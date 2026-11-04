import { describe, expect, it, vi } from "vitest";
import { chunkSegments } from "../chunk";
import { docKindOf } from "../classify";

const complete = vi.fn();
vi.mock("@/lib/mux", () => ({ complete: (...a: unknown[]) => complete(...a), completeJson: vi.fn() }));
const { extractPdf } = await import("./pdf");

/** A one-page PDF whose only content is a JPEG (what a scanner makes): no text layer. */
async function scannedPdf(): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1240" height="1754"><rect width="100%" height="100%" fill="white"/>
    <text x="100" y="200" font-family="Helvetica, Arial, sans-serif" font-size="64" fill="black">Kære forældre</text>
    <text x="100" y="320" font-family="Helvetica, Arial, sans-serif" font-size="44" fill="black">Skolen holder lukket fredag den 6. november.</text></svg>`;
  const jpg = await sharp(Buffer.from(svg)).jpeg({ quality: 85 }).toBuffer();
  const parts: Buffer[] = [];
  const offsets: number[] = [];
  let len = 0;
  const push = (b: Buffer | string) => { const buf = typeof b === "string" ? Buffer.from(b, "latin1") : b; parts.push(buf); len += buf.length; };
  const obj = (n: number, body: (Buffer | string)[]) => { offsets[n] = len; push(`${n} 0 obj\n`); body.forEach(push); push("\nendobj\n"); };
  push("%PDF-1.4\n");
  obj(1, ["<< /Type /Catalog /Pages 2 0 R >>"]);
  obj(2, ["<< /Type /Pages /Kids [3 0 R] /Count 1 >>"]);
  obj(3, ["<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>"]);
  obj(4, [`<< /Type /XObject /Subtype /Image /Width 1240 /Height 1754 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg.length} >>\nstream\n`, jpg, "\nendstream"]);
  const content = "q 595 0 0 842 0 0 cm /Im1 Do Q";
  obj(5, [`<< /Length ${content.length} >>\nstream\n${content}\nendstream`]);
  const xref = len;
  push(`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`);
  push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.concat(parts);
}

describe("scanned PDF pages", () => {
  it("reads a page without a text layer through vision, with a page locator", async () => {
    complete.mockResolvedValue({ model: "m", route: "vision", requestId: null, text: JSON.stringify({ kind: "document", description: "Et brev fra skolen.", language: "da", blocks: [{ region: "top", text: "Kære forældre" }, { region: "body", text: "Skolen holder lukket fredag den 6. november." }] }) });
    const ex = await extractPdf({ bytes: await scannedPdf(), sensitive: false, muxUp: true, muxMeta: { userId: "u", agent: "t" } });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0][0].messages[1].content[1].image_url.url).toMatch(/^data:image\/png;base64,/);
    expect(ex.textContent).toContain("Skolen holder lukket fredag den 6. november.");
    expect(ex.meta.scannedPages).toEqual({ withoutText: 1, read: 1 });
    expect(ex.warnings).toEqual([]);
    expect(chunkSegments(ex.segments)[0].locator).toMatchObject({ page: 1, image: "page 1" });
    expect(docKindOf({ mime: "application/pdf", meta: ex.meta })).toBe("scan");
  });

  it("falls back to tesseract for scanned pages when mux is down", async () => {
    complete.mockReset();
    const ex = await extractPdf({ bytes: await scannedPdf(), sensitive: false, muxUp: false, muxMeta: { userId: "u", agent: "t" } });
    expect(complete).not.toHaveBeenCalled();
    expect(ex.textContent).toMatch(/Kære forældre/);
    expect(ex.warnings.join(" ")).toMatch(/fallback text reader/);
  }, 120_000);
});
