import { afterEach, describe, expect, it, vi } from "vitest";
import { chunkSegments } from "../chunk";
import { docKindOf, ocrCharsOf } from "../classify";

// mux is mocked: the vision tests check what is sent and how the answer is used, not a model.
const complete = vi.fn();
const completeJson = vi.fn();
vi.mock("@/lib/mux", () => ({ complete: (...a: unknown[]) => complete(...a), completeJson: (...a: unknown[]) => completeJson(...a) }));

const { extractImage } = await import("./image");
const { parseVisionRead } = await import("./vision");
const { tesseractLangPath } = await import("./ocr");

/** A white PNG with two lines of Danish text, drawn with sharp from SVG. */
async function slidePng(width = 1100): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="420"><rect width="100%" height="100%" fill="white"/>
    <text x="40" y="120" font-family="Helvetica, Arial, sans-serif" font-size="60" fill="black">Dagsorden for mødet</text>
    <text x="40" y="230" font-family="Helvetica, Arial, sans-serif" font-size="46" fill="black">Forældremøde i klassen tirsdag</text>
    <text x="40" y="320" font-family="Helvetica, Arial, sans-serif" font-size="46" fill="black">Kaffe og kage bagefter</text></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

const meta = { userId: "u1", agent: "library", sensitive: true };

afterEach(() => { complete.mockReset(); completeJson.mockReset(); });

describe("pictures through vision", () => {
  it("sends one vision call (downscaled, sensitive kept) and keeps the text verbatim with its regions", async () => {
    complete.mockResolvedValue({
      model: "local-vision",
      route: "vision",
      requestId: "r1",
      text: "```json\n" + JSON.stringify({
        kind: "slide",
        description: "Et slide med dagsordenen for et forældremøde.",
        language: "da",
        blocks: [
          { region: "title", text: "Dagsorden for mødet" },
          { region: "body", text: "- Forældremøde i klassen tirsdag\n- Kaffe og kage bagefter" },
        ],
      }) + "\n```",
    });
    const png = await slidePng(4000);
    const ex = await extractImage({ bytes: png, mime: "image/png", sensitive: true, muxUp: true, muxMeta: meta });

    expect(complete).toHaveBeenCalledTimes(1);
    const call = complete.mock.calls[0][0];
    expect(call.route).toBe("vision");
    expect(call.meta.sensitive).toBe(true);
    const url: string = call.messages[1].content[1].image_url.url;
    expect(url.startsWith("data:image/png;base64,")).toBe(true);
    const sent = Buffer.from(url.split(",")[1], "base64");
    const sharp = (await import("sharp")).default;
    expect((await sharp(sent).metadata()).width).toBe(2048);

    expect(ex.textContent).toBe("Description: Et slide med dagsordenen for et forældremøde.\n\nText in the image:\nDagsorden for mødet\n\n- Forældremøde i klassen tirsdag\n- Kaffe og kage bagefter");
    expect(ex.meta).toMatchObject({ reader: "vision", ocr: "done", caption: "done", pictureKind: "slide", textLanguage: "da", captionModel: "local-vision" });
    expect(ex.activity).toBe("ocr");
    expect(chunkSegments(ex.segments)[0].locator).toMatchObject({ region: "title, body" });
    expect(ex.warnings).toEqual([]);
  });

  it("parses loose answers", () => {
    expect(parseVisionRead({ kind: "weird", description: "x", blocks: ["A", { text: "[unreadable]" }, { region: " ", text: "B " }] }))
      .toEqual({ kind: "other", description: "x", language: null, blocks: [{ region: null, text: "A" }, { region: null, text: "B" }] });
    expect(parseVisionRead({ text: "Hej\r\nmed dig", language: "DA" }).blocks).toEqual([{ region: null, text: "Hej\nmed dig" }]);
    expect(() => parseVisionRead("nope")).toThrow();
  });

  it("falls back to tesseract when the vision call fails", async () => {
    complete.mockRejectedValue(new Error("vision model unavailable"));
    const ex = await extractImage({ bytes: await slidePng(), mime: "image/png", sensitive: false, muxUp: true, muxMeta: meta });
    expect(ex.meta.reader).toBe("tesseract");
    expect(String(ex.meta.vision)).toMatch(/^failed: vision model unavailable/);
    expect(ex.textContent).toMatch(/Dagsorden/);
  }, 120_000);
});

describe("pictures without mux (bundled tesseract, eng+dan)", () => {
  it("has the language data in the repo", () => {
    expect(tesseractLangPath()).toMatch(/assets[\\/]tesseract$/);
  });

  it("reads Danish text off a PNG and records where it sits", async () => {
    const ex = await extractImage({ bytes: await slidePng(), mime: "image/png", sensitive: false, muxUp: false, muxMeta: meta });
    expect(complete).not.toHaveBeenCalled();
    expect(ex.meta.reader).toBe("tesseract");
    expect(ex.textContent).toMatch(/Dagsorden for mødet/);
    expect(ex.textContent).toMatch(/Forældremøde/);
    expect(ex.warnings.join(" ")).toMatch(/fallback text reader/);
    const loc = chunkSegments(ex.segments)[0].locator;
    expect(loc.bbox).toHaveLength(4);
    expect(docKindOf({ mime: "image/png", meta: ex.meta, ocrChars: ocrCharsOf(ex.textContent) })).toBe("photo");
  }, 120_000);
});
