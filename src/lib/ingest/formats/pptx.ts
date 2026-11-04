/**
 * PowerPoint (.pptx). A pptx is a zip of XML parts; this reads it with jszip and a small XML reader, no Office
 * dependency. Per slide, in order: the title, the text boxes and bullets (with their levels), tables as markdown
 * rows, and the speaker notes. Pictures on slides with little text are read through the vision path (capped per deck).
 * Locator: { slide: n } (and { image } for a picture). Server-only; `parsePptx` is pure apart from unzipping.
 */
import path from "node:path/posix";
import type { TextSegment } from "../chunk";
import { sniffImageMime } from "./image-prep";
import { packBlocks, readPicture } from "./picture";
import type { ExtractedText, ReadContext } from "./types";
import { attr, find, findAll, kid, kids, local, parseXml, type XmlNode } from "./xml";

export type PptxSlide = {
  n: number;
  title: string;
  /** Body lines in order: paragraphs, bullets ("- ", indented two spaces a level) and table rows. */
  lines: string[];
  notes: string;
  hidden: boolean;
  /** Zip paths of the pictures placed on the slide, in order. */
  pictures: string[];
};
export type PptxDeck = { title: string | null; slides: PptxSlide[]; files: Map<string, () => Promise<Uint8Array>> };

/** Pictures read per deck through vision (or the fallback reader when mux is down), and per slide. */
export const MAX_DECK_PICTURES = 8;
export const MAX_DECK_PICTURES_OCR = 4;
const MAX_SLIDE_PICTURES = 3;
/** A slide with less body text than this is "mostly picture": its pictures get read. */
const LITTLE_TEXT = 120;
/** Smaller files are icons, bullets and logos. */
const MIN_PICTURE_BYTES = 12 * 1024;
const MAX_SLIDES = 500;

const SKIP_PLACEHOLDERS = new Set(["sldNum", "dt", "ftr", "hdr"]);
const TITLE_PLACEHOLDERS = new Set(["title", "ctrTitle"]);

type Rels = Map<string, { target: string; type: string }>;

function parseRels(xml: string | undefined, partPath: string): Rels {
  const out: Rels = new Map();
  if (!xml) return out;
  const base = path.dirname(partPath);
  for (const r of findAll(parseXml(xml), "Relationship")) {
    const id = attr(r, "Id");
    const target = attr(r, "Target");
    if (!id || !target || attr(r, "TargetMode") === "External") continue;
    out.set(id, { target: target.startsWith("/") ? target.slice(1) : path.normalize(path.join(base, target)), type: attr(r, "Type") ?? "" });
  }
  return out;
}

const relsPathOf = (part: string) => `${path.dirname(part)}/_rels/${path.basename(part)}.rels`;

/** The text of one paragraph: runs, fields and line breaks. */
function paragraphText(p: XmlNode): string {
  let s = "";
  for (const c of p.children) {
    const n = local(c.name);
    if (n === "r" || n === "fld") s += kids(c, "t").map((t) => t.text).join("");
    else if (n === "br") s += "\n";
  }
  return s.replace(/\u000b/g, "\n").replace(/[ \t]+/g, " ").trim();
}

/** The paragraphs of a text body as lines, with bullets where the slide shows them. */
function bodyLines(txBody: XmlNode, bulletsByDefault: boolean): string[] {
  const out: string[] = [];
  const numbers: number[] = [];
  for (const p of kids(txBody, "p")) {
    const text = paragraphText(p);
    if (!text) continue;
    const pPr = kid(p, "pPr");
    const lvl = Math.min(8, Number(attr(pPr, "lvl") ?? 0) || 0);
    const none = !!(pPr && kid(pPr, "buNone"));
    const auto = pPr ? kid(pPr, "buAutoNum") : undefined;
    const char = !!(pPr && kid(pPr, "buChar"));
    const indent = "  ".repeat(lvl);
    numbers.length = lvl + 1;
    if (auto && !none) {
      numbers[lvl] = (numbers[lvl] ?? Number(attr(auto, "startAt") ?? 1) - 1) + 1;
      out.push(`${indent}${numbers[lvl]}. ${text}`);
    } else if (!none && (char || bulletsByDefault)) out.push(`${indent}- ${text.replace(/\n/g, `\n${indent}  `)}`);
    else out.push(text);
  }
  return out;
}

const cell = (s: string) => s.replace(/\s*\n\s*/g, " / ").replace(/\|/g, "\\|").trim();

/** A table as markdown rows; the first row is taken as the header. */
function tableLines(tbl: XmlNode): string[] {
  const rows = kids(tbl, "tr").map((tr) => kids(tr, "tc").filter((tc) => attr(tc, "hMerge") !== "1" && attr(tc, "vMerge") !== "1")
    .map((tc) => { const b = kid(tc, "txBody"); return b ? cell(kids(b, "p").map(paragraphText).filter(Boolean).join("\n")) : ""; }));
  const width = Math.max(0, ...rows.map((r) => r.length));
  if (!width || rows.every((r) => r.every((c) => !c))) return [];
  const line = (r: string[]) => `| ${Array.from({ length: width }, (_, i) => r[i] ?? "").join(" | ")} |`;
  return [line(rows[0]), `|${" --- |".repeat(width)}`, ...rows.slice(1).map(line)];
}

type Shape = { kind: "title"; lines: string[] } | { kind: "text"; lines: string[] } | { kind: "picture"; embed: string };

/** Shapes of a slide's tree in document order (group shapes flattened). */
function shapes(tree: XmlNode, out: Shape[] = []): Shape[] {
  for (const c of tree.children) {
    const n = local(c.name);
    if (n === "sp") {
      const ph = find(kid(c, "nvSpPr") ?? c, "ph");
      const type = ph ? attr(ph, "type") ?? "body" : null;
      if (type && SKIP_PLACEHOLDERS.has(type)) continue;
      const body = kid(c, "txBody");
      if (!body) continue;
      if (type && TITLE_PLACEHOLDERS.has(type)) out.push({ kind: "title", lines: kids(body, "p").map((p) => paragraphText(p).replace(/\n/g, " ")).filter(Boolean) });
      else out.push({ kind: "text", lines: bodyLines(body, type === "body" || type === "obj") });
    } else if (n === "graphicFrame") {
      const tbl = find(c, "tbl");
      if (tbl) out.push({ kind: "text", lines: tableLines(tbl) });
    } else if (n === "pic") {
      const embed = attr(find(c, "blip"), "embed");
      if (embed) out.push({ kind: "picture", embed });
    } else if (n === "grpSp") shapes(c, out);
    else if (n === "AlternateContent") {
      // Newer content with a fallback: read the fallback once.
      const fb = kid(c, "Fallback") ?? kid(c, "Choice");
      if (fb) shapes(fb, out);
    }
  }
  return out;
}

function notesText(xml: string | undefined): string {
  if (!xml) return "";
  const tree = find(parseXml(xml), "spTree");
  if (!tree) return "";
  const lines: string[] = [];
  for (const sp of findAll(tree, "sp")) {
    const ph = find(kid(sp, "nvSpPr") ?? sp, "ph");
    if (!ph || (attr(ph, "type") ?? "body") !== "body") continue;
    const body = kid(sp, "txBody");
    if (body) lines.push(...bodyLines(body, false));
  }
  return lines.join("\n").trim();
}

/** Unzip and read a deck's structure. Throws a plain-English error for files that aren't a readable pptx. */
export async function parsePptx(bytes: Uint8Array): Promise<PptxDeck> {
  const JSZip = (await import("jszip")).default;
  let zip: InstanceType<typeof JSZip>;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new Error("This presentation couldn't be opened. It may be damaged, or protected with a password.");
  }
  const read = (p: string) => zip.file(p)?.async("string");
  const presXml = await read("ppt/presentation.xml");
  if (!presXml) throw new Error("This file isn't a PowerPoint presentation (.pptx), or it is protected with a password.");

  const core = await read("docProps/core.xml");
  const title = core ? (find(parseXml(core), "title")?.text.trim() || null) : null;

  // Slide order comes from the presentation's slide list; fall back to the slide files' numbers.
  const presRels = parseRels(await read("ppt/_rels/presentation.xml.rels"), "ppt/presentation.xml");
  let slidePaths = findAll(parseXml(presXml), "sldId").map((s) => presRels.get(attr(s, "id") ?? "")?.target).filter((t): t is string => !!t && !!zip.file(t));
  if (!slidePaths.length) {
    slidePaths = Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
      .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)![1]) - Number(/(\d+)\.xml$/.exec(b)![1]));
  }

  const slides: PptxSlide[] = [];
  for (const [i, sp] of slidePaths.slice(0, MAX_SLIDES).entries()) {
    const doc = parseXml((await read(sp)) ?? "");
    const rels = parseRels(await read(relsPathOf(sp)), sp);
    const sld = doc.children.find((c) => local(c.name) === "sld");
    const tree = find(doc, "spTree");
    const parts = tree ? shapes(tree) : [];
    const titleLines = parts.filter((s): s is Extract<Shape, { kind: "title" }> => s.kind === "title").flatMap((s) => s.lines);
    const lines = parts.filter((s): s is Extract<Shape, { kind: "text" }> => s.kind === "text").flatMap((s) => s.lines);
    const pictures = parts.filter((s): s is Extract<Shape, { kind: "picture" }> => s.kind === "picture")
      .map((s) => rels.get(s.embed)?.target).filter((t): t is string => !!t && !!zip.file(t));
    const notesRel = [...rels.values()].find((r) => r.type.endsWith("/notesSlide"));
    slides.push({
      n: i + 1,
      title: titleLines.join(" ").trim(),
      lines,
      notes: notesText(notesRel ? await read(notesRel.target) : undefined),
      hidden: attr(sld, "show") === "0",
      pictures: [...new Set(pictures)],
    });
  }
  const files = new Map<string, () => Promise<Uint8Array>>();
  for (const s of slides) for (const p of s.pictures) files.set(p, () => zip.file(p)!.async("uint8array"));
  return { title, slides, files };
}

/** One slide as text: "Slide 3: Title", the body, then the speaker notes. */
export function slideText(s: PptxSlide): string {
  const head = `Slide ${s.n}${s.title ? `: ${s.title}` : ""}${s.hidden ? " (hidden)" : ""}`;
  return [head, ...(s.lines.length ? [s.lines.join("\n")] : []), ...(s.notes ? [`Speaker notes:\n${s.notes}`] : [])].join("\n\n");
}

/** Which pictures to read: those on slides with little text, not repeated on many slides (logos), capped. */
export function picturesToRead(deck: Pick<PptxDeck, "slides">, cap: number): { slide: number; path: string }[] {
  const uses = new Map<string, number>();
  for (const s of deck.slides) for (const p of s.pictures) uses.set(p, (uses.get(p) ?? 0) + 1);
  const out: { slide: number; path: string }[] = [];
  const seen = new Set<string>();
  for (const s of deck.slides) {
    const body = s.lines.join("\n").length;
    if (body >= LITTLE_TEXT) continue;
    for (const p of s.pictures.slice(0, MAX_SLIDE_PICTURES)) {
      if (out.length >= cap) return out;
      if (seen.has(p) || (uses.get(p) ?? 0) >= 3 || !/\.(png|jpe?g|gif|webp|tiff?|bmp)$/i.test(p)) continue;
      seen.add(p);
      out.push({ slide: s.n, path: p });
    }
  }
  return out;
}

export async function extractPptx(opts: { bytes: Buffer; filename: string } & ReadContext): Promise<ExtractedText> {
  const deck = await parsePptx(opts.bytes);
  const warnings: string[] = [];
  const meta: Record<string, unknown> = { slides: deck.slides.length, documentTitle: deck.title };
  if (!deck.slides.length) warnings.push("The presentation has no slides.");

  // Pictures on slides that are mostly picture (a pasted screenshot, a diagram).
  const cap = opts.muxUp ? MAX_DECK_PICTURES : MAX_DECK_PICTURES_OCR;
  const wanted = picturesToRead(deck, cap);
  const pictureSegs = new Map<number, TextSegment[]>();
  let read = 0;
  let failed = 0;
  let viaOcr = 0;
  for (const w of wanted) {
    const data = Buffer.from(await deck.files.get(w.path)!());
    const mime = sniffImageMime(data);
    if (!mime || data.byteLength < MIN_PICTURE_BYTES) continue;
    const r = await readPicture(data, mime, opts, { hint: `This picture is on slide ${w.slide} of the presentation "${deck.title ?? opts.filename}".` });
    if (!r.reader) { failed++; continue; }
    if (!r.text && !r.description) continue;
    read++;
    if (r.reader === "tesseract") viaOcr++;
    const label = `Picture on slide ${w.slide}${r.kind ? ` (${r.kind})` : ""}`;
    const groups = r.text ? packBlocks(r.blocks) : [];
    const segs: TextSegment[] = [];
    const first = [r.description ? `${label}: ${r.description}` : `${label}:`, ...(groups[0] ? [`Text in the picture:\n${groups[0].text}`] : [])].join("\n");
    segs.push({ text: first, at: { slide: w.slide, image: w.path, ...(groups[0]?.region ? { region: groups[0].region } : {}) } });
    for (const g of groups.slice(1)) segs.push({ text: g.text, at: { slide: w.slide, image: w.path, ...(g.region ? { region: g.region } : {}) } });
    pictureSegs.set(w.slide, [...(pictureSegs.get(w.slide) ?? []), ...segs]);
  }
  meta.picturesRead = read;
  if (failed) warnings.push(`${failed} picture${failed === 1 ? "" : "s"} on the slides couldn't be read${opts.muxUp ? "" : " (the model gateway, mux, is unreachable)"}.`);
  if (viaOcr) warnings.push("Pictures on the slides were read with the fallback text reader because mux was unreachable.");
  const totalPictures = new Set(deck.slides.flatMap((s) => s.pictures)).size;
  if (wanted.length >= cap && totalPictures > cap) warnings.push(`Only the first ${cap} pictures on mostly-picture slides were read.`);

  const segments: TextSegment[] = [];
  const texts: string[] = [];
  if (deck.title && deck.title.trim() !== opts.filename.replace(/\.[a-z0-9]+$/i, "").trim()) texts.push(`Presentation: ${deck.title}`);
  for (const s of deck.slides) {
    const t = slideText(s);
    const lead = segments.length === 0 && texts.length ? `${texts[0]}\n\n` : "";
    segments.push({ text: lead + t, at: { slide: s.n } });
    texts.push(t);
    for (const ps of pictureSegs.get(s.n) ?? []) {
      segments.push(ps);
      texts.push(ps.text);
    }
  }
  // The deck's own text is the file's; only a deck that is nothing but pictures counts as read off images.
  const allPictures = read > 0 && deck.slides.every((s) => !s.title && !s.lines.length && !s.notes);
  return { segments, textContent: texts.join("\n\n"), meta, warnings, activity: allPictures ? "ocr" : "upload" };
}
