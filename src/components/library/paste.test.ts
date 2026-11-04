import { describe, expect, it } from "vitest";
import { choosePaste, htmlToText, isApplePlatform, pastedFiles, soleUrl, sourceUrlOf, titleFromText } from "./paste";

const file = (name: string, type: string, body = "x") => new File([body], name, { type });

describe("titleFromText", () => {
  it("takes the first line that has words, without markdown marks", () => {
    expect(titleFromText("\n\n# Packing list for Skagen\n- swimsuit")).toBe("Packing list for Skagen");
    expect(titleFromText("- [ ] Ring til tandlægen\nom tirsdagen")).toBe("Ring til tandlægen");
    expect(titleFromText("  **Forældremøde** i 3.B  ")).toBe("Forældremøde i 3.B");
    expect(titleFromText("1. Buy milk")).toBe("Buy milk");
  });

  it("cuts long lines at a word", () => {
    const t = titleFromText("This is a really long first line that keeps going and going well past what anyone would read as a title")!;
    expect(t.length).toBeLessThanOrEqual(80);
    expect(t.endsWith("…")).toBe(true);
    expect(t).not.toMatch(/\s…$/);
  });

  it("gives null when there is nothing worth a title", () => {
    expect(titleFromText("")).toBeNull();
    expect(titleFromText("   \n --- \n")).toBeNull();
    expect(titleFromText("a")).toBeNull();
  });
});

describe("soleUrl", () => {
  it("accepts a web address on its own", () => {
    expect(soleUrl("https://www.aula.dk/portal/")).toBe("https://www.aula.dk/portal/");
    expect(soleUrl("  http://example.com  ")).toBe("http://example.com/");
    expect(soleUrl("www.dr.dk/nyheder")).toBe("https://www.dr.dk/nyheder");
    expect(soleUrl("<https://example.com/a>")).toBe("https://example.com/a");
  });

  it("refuses text with a link in it, other schemes and odd hosts", () => {
    expect(soleUrl("see https://example.com")).toBeNull();
    expect(soleUrl("https://example.com\nhttps://example.org")).toBeNull();
    expect(soleUrl("ftp://example.com")).toBeNull();
    expect(soleUrl("javascript:alert(1)")).toBeNull();
    expect(soleUrl("https://intranet/")).toBeNull();
    expect(soleUrl("https://user:pw@example.com/")).toBeNull();
    expect(soleUrl("example.com")).toBeNull();
    expect(soleUrl("")).toBeNull();
  });
});

describe("sourceUrlOf", () => {
  it("reads Firefox's url-and-title and the uri-list", () => {
    expect(sourceUrlOf({ mozUrl: "https://example.com/page\nThe page" })).toEqual({ url: "https://example.com/page", title: "The page" });
    expect(sourceUrlOf({ uriList: "# comment\r\nhttps://example.com/b\r\n" })).toEqual({ url: "https://example.com/b", title: null });
    expect(sourceUrlOf({})).toBeNull();
  });
});

describe("htmlToText", () => {
  it("keeps paragraphs and list items, drops tags, scripts and entities", () => {
    const html = "<html><head><style>p{}</style></head><body><!--StartFragment--><h1>Skolefest</h1><p>Fredag kl.&nbsp;17 &amp; mad</p><ul><li>Emma</li><li>Noah</li></ul><script>x()</script><!--EndFragment--></body></html>";
    expect(htmlToText(html)).toBe("Skolefest\n\nFredag kl. 17 & mad\n\n- Emma\n- Noah");
    expect(htmlToText("a&#230;b&#x00F8;c")).toBe("aæbøc");
  });
});

describe("choosePaste", () => {
  it("files win: Finder and Explorer copies keep every file and its name", () => {
    const files = [file("Brev fra skolen.pdf", "application/pdf"), file("IMG_2041.jpg", "image/jpeg")];
    const c = choosePaste({ files, text: "Brev fra skolen.pdf\nIMG_2041.jpg" });
    expect(c.kind).toBe("files");
    if (c.kind === "files") expect(c.files.map((f) => f.name)).toEqual(["Brev fra skolen.pdf", "IMG_2041.jpg"]);
  });

  it("files are taken even when focus is in a field", () => {
    expect(choosePaste({ files: [file("a.png", "image/png")], inField: true }).kind).toBe("files");
  });

  it("a picture of copied text (Word, Excel) is the text", () => {
    const c = choosePaste({ files: [file("image.png", "image/png")], text: "Name\tClass\nEmma\t3.B", html: "<table><tr><td>Name</td></tr></table>" });
    expect(c.kind).toBe("text");
  });

  it("an image copied from a page with its address stays an image", () => {
    expect(choosePaste({ files: [file("image.png", "image/png")], text: "https://example.com/cat.png", html: "<img src='https://example.com/cat.png'>" }).kind).toBe("files");
  });

  it("a web address on its own is a page to save", () => {
    expect(choosePaste({ files: [], text: "https://www.aula.dk/" })).toEqual({ kind: "url", url: "https://www.aula.dk/", title: null });
    expect(choosePaste({ files: [], text: "https://example.com/x", mozUrl: "https://example.com/x\nExample" })).toEqual({ kind: "url", url: "https://example.com/x", title: "Example" });
    expect(choosePaste({ files: [], uriList: "https://example.com/y" })).toEqual({ kind: "url", url: "https://example.com/y", title: null });
  });

  it("text is a note, with the page it came from when the clipboard says", () => {
    expect(choosePaste({ files: [], text: "Husk madpakke på fredag" })).toEqual({ kind: "text", text: "Husk madpakke på fredag", sourceUrl: null });
    expect(choosePaste({ files: [], text: "Opening hours 9–17", html: "<p>Opening hours 9–17</p>", mozUrl: "https://museum.dk/visit\nVisit" }))
      .toEqual({ kind: "text", text: "Opening hours 9–17", sourceUrl: "https://museum.dk/visit" });
  });

  it("rich text without a plain version is turned into text", () => {
    const c = choosePaste({ files: [], html: "<p>Line one</p><p>Line two</p>" });
    expect(c).toEqual({ kind: "text", text: "Line one\n\nLine two", sourceUrl: null });
  });

  it("text pasted into a field, and an empty clipboard, are not ours", () => {
    expect(choosePaste({ files: [], text: "hello", inField: true }).kind).toBe("none");
    expect(choosePaste({ files: [], text: "   " }).kind).toBe("none");
    expect(choosePaste({ files: [] }).kind).toBe("none");
  });
});

describe("pastedFiles", () => {
  it("collects from files and items once each", () => {
    const a = file("a.pdf", "application/pdf"), b = file("b.txt", "text/plain");
    const dt = {
      files: [a] as unknown as FileList,
      items: [
        { kind: "file", getAsFile: () => new File([a], "a.pdf", { type: "application/pdf" }) },
        { kind: "file", getAsFile: () => b },
        { kind: "string", getAsFile: () => null },
      ] as unknown as DataTransferItemList,
    };
    expect(pastedFiles(dt).map((f) => f.name)).toEqual(["a.pdf", "b.txt"]);
    expect(pastedFiles(null)).toEqual([]);
  });
});

describe("isApplePlatform", () => {
  it("knows Macs and iPhones", () => {
    expect(isApplePlatform({ platform: "MacIntel" })).toBe(true);
    expect(isApplePlatform({ userAgentData: { platform: "Windows" } })).toBe(false);
    expect(isApplePlatform({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)" })).toBe(true);
  });
});
