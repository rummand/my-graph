import { describe, expect, it } from "vitest";
import { chunkSegments } from "../chunk";
import { extractPptx, parsePptx, picturesToRead, slideText } from "./pptx";
import { parseXml, find, attr } from "./xml";

const ctx = { sensitive: false, muxUp: false, muxMeta: { userId: "u", agent: "test" } };

async function buildDeck(): Promise<Buffer> {
  const PptxGenJS = (await import("pptxgenjs")).default;
  const pptx = new PptxGenJS();
  pptx.title = "Skoleåret 2026";
  pptx.defineSlideMaster({ title: "M", objects: [], slideNumber: { x: 9, y: 5.2 } });

  const s1 = pptx.addSlide({ masterName: "M" });
  s1.addText("Velkommen til forældremødet", { placeholder: undefined, x: 0.5, y: 0.3, w: 9, h: 1, fontSize: 32 });
  s1.addText([
    { text: "Lejrskole i uge 38", options: { bullet: true } },
    { text: "Pakkeliste kommer på Aula", options: { bullet: true, indentLevel: 1 } },
    { text: "Forældrekaffe fredag", options: { bullet: true } },
  ], { x: 0.5, y: 1.5, w: 9, h: 2 });
  s1.addNotes("Husk at nævne betalingen på 450 kr.");

  const s2 = pptx.addSlide();
  s2.addText("Kontaktpersoner", { x: 0.5, y: 0.3, w: 9, h: 1 });
  s2.addTable([
    [{ text: "Navn" }, { text: "Rolle" }],
    [{ text: "Mette Hansen" }, { text: "Klasselærer" }],
    [{ text: "Jonas Berg" }, { text: "Pædagog" }],
  ], { x: 0.5, y: 1.5, w: 8 });

  const s3 = pptx.addSlide();
  // A slide that is only a picture (a pasted screenshot): a 1×1 PNG, too small to be read but listed.
  s3.addImage({ data: "image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", x: 1, y: 1, w: 4, h: 3 });

  const out = await pptx.write({ outputType: "nodebuffer" });
  return out as Buffer;
}

describe("pptx", () => {
  it("reads slides in order: title, bullets with levels, tables, notes, pictures", async () => {
    const bytes = await buildDeck();
    const deck = await parsePptx(bytes);
    expect(deck.title).toBe("Skoleåret 2026");
    expect(deck.slides).toHaveLength(3);

    const [a, b, c] = deck.slides;
    const t1 = slideText(a);
    expect(t1).toContain("Velkommen til forældremødet");
    expect(t1).toMatch(/- Lejrskole i uge 38\n {2}- Pakkeliste kommer på Aula\n- Forældrekaffe fredag/);
    expect(t1).toContain("Speaker notes:\nHusk at nævne betalingen på 450 kr.");

    const t2 = slideText(b);
    expect(t2).toContain("| Navn | Rolle |");
    expect(t2).toContain("| --- | --- |");
    expect(t2).toContain("| Jonas Berg | Pædagog |");

    expect(c.pictures).toHaveLength(1);
    expect(c.pictures[0]).toMatch(/^ppt\/media\//);
    expect(picturesToRead(deck, 5)).toEqual([{ slide: 3, path: c.pictures[0] }]);
  });

  it("returns per-slide segments with { slide } locators", async () => {
    const ex = await extractPptx({ bytes: await buildDeck(), filename: "Forældremøde.pptx", ...ctx });
    expect(ex.meta.slides).toBe(3);
    expect(ex.meta.documentTitle).toBe("Skoleåret 2026");
    expect(ex.textContent.startsWith("Presentation: Skoleåret 2026")).toBe(true);
    const chunks = chunkSegments(ex.segments);
    expect(chunks.find((ch) => ch.text.includes("Lejrskole"))?.locator).toMatchObject({ slide: 1 });
    expect(chunks.find((ch) => ch.text.includes("Pædagog"))?.locator).toMatchObject({ slide: 2 });
    expect(ex.activity).toBe("upload");
  });

  it("reads PowerPoint's own placeholders: title first, body bullets by default, slide numbers skipped", async () => {
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    const ns = `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`;
    zip.file("ppt/presentation.xml", `<p:presentation ${ns}><p:sldIdLst><p:sldId id="257" r:id="rId9"/></p:sldIdLst></p:presentation>`);
    zip.file("ppt/_rels/presentation.xml.rels", `<Relationships><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide7.xml"/></Relationships>`);
    const sp = (ph: string, body: string) => `<p:sp><p:nvSpPr><p:cNvPr id="2" name="x"/><p:cNvSpPr/><p:nvPr>${ph}</p:nvPr></p:nvSpPr><p:txBody>${body}</p:txBody></p:sp>`;
    zip.file("ppt/slides/slide7.xml", `<p:sld ${ns}><p:cSld><p:spTree>
      ${sp(`<p:ph idx="1"/>`, `<a:p><a:r><a:t>Første punkt</a:t></a:r></a:p><a:p><a:pPr lvl="1"/><a:r><a:t>Under</a:t></a:r><a:r><a:t>punkt</a:t></a:r></a:p><a:p><a:pPr><a:buNone/></a:pPr><a:r><a:t>Uden prik</a:t></a:r></a:p>`)}
      ${sp(`<p:ph type="sldNum" idx="12"/>`, `<a:p><a:fld type="slidenum"><a:t>7</a:t></a:fld></a:p>`)}
      ${sp(`<p:ph type="title"/>`, `<a:p><a:r><a:t>Årsplan</a:t></a:r><a:br/><a:r><a:t>for 3.B</a:t></a:r></a:p>`)}
    </p:spTree></p:cSld></p:sld>`);
    const deck = await parsePptx(await zip.generateAsync({ type: "uint8array" }));
    expect(slideText(deck.slides[0])).toBe("Slide 1: Årsplan for 3.B\n\n- Første punkt\n  - Underpunkt\nUden prik");
  });

  it("refuses something that isn't a presentation in plain words", async () => {
    await expect(parsePptx(Buffer.from("not a zip"))).rejects.toThrow(/couldn't be opened/);
  });
});

describe("xml", () => {
  it("parses attributes, entities and nesting", () => {
    const doc = parseXml(`<?xml version="1.0"?><a:p xmlns:a="x"><a:r><a:t>Søren &amp; Ida &#x2192; &lt;3</a:t></a:r><a:br/><r:x r:embed='rId2'/></a:p>`);
    expect(find(doc, "t")?.text).toBe("Søren & Ida → <3");
    expect(attr(find(doc, "x"), "embed")).toBe("rId2");
  });
});
