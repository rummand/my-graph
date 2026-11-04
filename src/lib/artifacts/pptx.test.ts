import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { builtinSets, type DesignTokens } from "@/lib/design-sets/tokens";
import { parseContent, type ArtifactContent } from "./content";
import { buildPptx, citesOnSlide, dataUriImage, imageSize, linesFor, onAccent, pitchFamily, planSlides, plainText, standardFont } from "./pptx";

const N1 = "11111111-1111-4111-8111-111111111111";
const S1 = "33333333-3333-4333-8333-333333333333";

// 1×1 PNG and a 3×2 GIF.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const GIF = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 3, 0, 2, 0, 0, 0, 0]);

function tokens(): DesignTokens {
  const s = builtinSets()[0];
  return { ...s.tokens, colors: { ...s.tokens.colors, light: { ...s.tokens.colors.light, accent: "#2f4bb0", bg: "#fdfcf8", ink: "#1b1b1f" } }, fonts: { display: "Fraunces", body: "Inter" } };
}

function deck(): ArtifactContent {
  return parseContent({
    subtitle: "Spring term",
    sections: [
      { id: "s1", title: "Overview", blocks: [{ id: "b1", type: "text", text: "@[Emma](node:11111111-1111-4111-8111-111111111111) started in 3rd grade [^c1]. She loves football [^c2]." }] },
      { id: "s2", title: "Key facts", blocks: [{ id: "b2", type: "facts", items: [{ label: "School", value: "Strandskolen", cites: ["c1"] }, { label: "Class", value: "3.B", cites: [] }] }] },
      { id: "s3", title: "What's coming", blocks: [{ id: "b3", type: "timeline", items: [{ when: "12 May", label: "Parents' evening", detail: "In the hall", cites: ["c2"] }] }] },
    ],
    citations: [
      { id: "c1", kind: "node", nodeId: N1, label: "Emma", quote: null, locator: null },
      { id: "c2", kind: "source", sourceId: S1, label: "Aula letter, 3 March", quote: "Emma plays football on Tuesdays", locator: "p. 1" },
    ],
  });
}

async function slidesOf(buf: Buffer) {
  const zip = await JSZip.loadAsync(buf);
  const slideNames = Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
  const read = (n: string) => zip.file(n)!.async("string");
  return { zip, slideNames, read };
}

describe("PowerPoint export", () => {
  it("builds a deck: cover, a slide per section and the sources, in the design's colours and fonts", async () => {
    const buf = await buildPptx({
      kind: "deck", title: "Emma's school year", content: deck(), tokens: tokens(),
      template: { cover: "band", showLogo: true, footer: "The Hansens" }, status: "draft", byline: "Mads · Family · 4 Nov 2026",
      logo: dataUriImage(`data:image/png;base64,${PNG}`),
    });
    expect(buf.subarray(0, 2).toString()).toBe("PK");
    const { zip, slideNames, read } = await slidesOf(buf);
    expect(slideNames).toHaveLength(5);
    const all = (await Promise.all(slideNames.map(read))).join("\n");
    expect(all).toContain('srgbClr val="2F4BB0"'); // accent: the band cover and the citation numbers
    expect(all).toContain('srgbClr val="FDFCF8"'); // background
    expect(all).toContain('srgbClr val="1B1B1F"'); // ink
    expect(all).toContain("Emma&apos;s school year");
    expect(all).toContain("The Hansens");
    expect(all).toMatch(/baseline="30000"/); // superscript citation numbers
    expect(all).toContain('typeface="Fraunces" pitchFamily="18"'); // serif display font falls back to a serif
    expect(all).toContain('typeface="Inter" pitchFamily="34"');
    const theme = await zip.file("ppt/theme/theme1.xml")!.async("string");
    expect(theme).toContain('typeface="Fraunces"');
    expect(theme).toContain('typeface="Inter"');
    expect(Object.keys(zip.files).some((n) => n.startsWith("ppt/media/"))).toBe(true); // the logo
    const notes = (await Promise.all(Object.keys(zip.files).filter((n) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n)).map((n) => zip.file(n)!.async("string")))).join("\n");
    expect(notes).toContain("Sources on this slide");
    expect(notes).toContain("Aula letter, 3 March (p. 1)");
  });

  it("gives a report a simple deck too, splitting long sections over slides", async () => {
    const long = parseContent({
      subtitle: "",
      sections: [{ id: "s1", title: "Notes", blocks: [{ id: "b1", type: "text", text: Array.from({ length: 14 }, (_, i) => `Paragraph ${i + 1}. ${"A sentence that goes on for a while. ".repeat(6)}`).join("\n\n") }] }],
      citations: [],
    });
    const plan = planSlides({ content: long, tokens: tokens() });
    expect(plan.filter((s) => s.type === "section").length).toBeGreaterThan(1);
    expect(plan.some((s) => s.type === "section" && s.continued)).toBe(true);
    expect(plan.some((s) => s.type === "sources")).toBe(false);
    const buf = await buildPptx({ kind: "report", title: "Notes", content: long, tokens: tokens(), template: { cover: "plain", showLogo: false, footer: "" }, status: "published", byline: "" });
    const { slideNames, read } = await slidesOf(buf);
    expect(slideNames).toHaveLength(plan.length);
    expect((await Promise.all(slideNames.map(read))).join("")).toContain("Notes (continued)");
  });

  it("repeats a table's header on every slide it spans and keeps headings with what follows", () => {
    const content = parseContent({
      subtitle: "",
      sections: [{ id: "s1", title: "Costs", blocks: [
        { id: "h", type: "heading", text: "By month" },
        { id: "t", type: "table", columns: ["Month", "Amount"], rows: Array.from({ length: 30 }, (_, i) => ({ cells: [`Month ${i + 1}`, `${i * 10}`], cites: [] })) },
      ] }],
      citations: [],
    });
    const plan = planSlides({ content, tokens: tokens() }).filter((s) => s.type === "section");
    expect(plan.length).toBeGreaterThan(1);
    for (const s of plan) if (s.type === "section") expect(s.pieces.find((p) => p.t === "row")).toMatchObject({ head: true });
    const first = plan[0];
    if (first.type === "section") expect(first.pieces[0].t).toBe("heading");
  });

  it("lists the citations drawn on a slide for its notes", () => {
    const plan = planSlides({ content: deck(), tokens: tokens() });
    expect(citesOnSlide(plan[1])).toEqual(["c1", "c2"]);
    expect(citesOnSlide(plan[3])).toEqual(["c2"]);
    expect(plan[plan.length - 1]).toMatchObject({ type: "sources" });
  });

  it("measures text and images", () => {
    expect(plainText("@[Emma](node:11111111-1111-4111-8111-111111111111) plays [^c1].")).toBe("Emma plays.");
    expect(linesFor("short", 10, 17)).toBe(1);
    expect(linesFor("x".repeat(400), 5, 17)).toBeGreaterThan(4);
    expect(imageSize(Buffer.from(PNG, "base64"))).toEqual({ w: 1, h: 1 });
    expect(imageSize(GIF)).toEqual({ w: 3, h: 2 });
    expect(imageSize(Buffer.from("not an image"))).toBeNull();
    expect(dataUriImage("data:image/svg+xml;base64,PHN2Zy8+")).toBeNull();
    expect(pitchFamily("Literata")).toBe(18);
    expect(pitchFamily("Schibsted Grotesk")).toBe(34);
    expect(onAccent({ bg: "#ffffff", surface: "#f5f5f5", ink: "#111111", muted: "#666666", accent: "#2f4bb0", accent2: "#aa3300", line: "#dddddd" })).toBe("#ffffff");
    expect(onAccent({ bg: "#ffffff", surface: "#f5f5f5", ink: "#111111", muted: "#666666", accent: "#ffd84d", accent2: "#aa3300", line: "#dddddd" })).toBe("#111111");
  });
});

describe("PowerPoint standard fonts", () => {
  it("uses Arial and Georgia when asked", async () => {
    const buf = await buildPptx({
      kind: "one_pager", title: "One page", content: deck(), tokens: tokens(), template: { cover: "plain", showLogo: false, footer: "" }, status: "published", byline: "", fonts: "standard",
    });
    const { slideNames, read } = await slidesOf(buf);
    const all = (await Promise.all(slideNames.map(read))).join("");
    expect(all).toContain('typeface="Georgia"');
    expect(all).toContain('typeface="Arial"');
    expect(all).not.toContain('typeface="Fraunces"');
    expect(standardFont("Literata")).toBe("Georgia");
  });
});
