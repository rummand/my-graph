/**
 * PDF: the text layer of each page (unpdf), and for pages without one (scans, photographed letters) the page's
 * picture read through the vision path, with tesseract as the fallback when mux is down. Rendering a page needs
 * a canvas library (@napi-rs/canvas, ~40 MB native); instead the largest embedded image of the page is taken, which
 * is what a scanner or phone puts on each page. Locator: { page } (+ { image: "page n" } for a read picture).
 * Server-only.
 */
import type { TextSegment } from "../chunk";
import { parsePdfDate, type DateCandidate } from "../document-date";
import { encodeRaw, VISION_MAX_SIDE } from "./image-prep";
import { packBlocks, readPicture } from "./picture";
import { errText, type ExtractedText, type ReadContext } from "./types";

/** A page with less text than this has no real text layer. */
const PAGE_MIN_CHARS = 20;
export const MAX_SCANNED_PAGES = 30;
export const MAX_SCANNED_PAGES_OCR = 8;
/** An image smaller than this isn't a page scan (a logo, a signature). */
const MIN_SCAN_SIDE = 400;

export async function extractPdf(opts: { bytes: Buffer } & ReadContext): Promise<ExtractedText> {
  const { getDocumentProxy, extractText: pdfText, getMeta, extractImages } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(opts.bytes));
  const { totalPages, text } = await pdfText(pdf, { mergePages: false });
  const dates: DateCandidate[] = [];
  try {
    const { info } = await getMeta(pdf);
    const created = parsePdfDate(info?.CreationDate) ?? parsePdfDate(info?.ModDate);
    if (created) dates.push({ at: created, precision: "minute", origin: "pdf" });
  } catch { /* no metadata */ }
  const pages = text.map((t) => t.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").trim());
  const warnings: string[] = [];
  const meta: Record<string, unknown> = { pages: totalPages };

  // Pages without a text layer: read the scan on them.
  const blank = pages.map((p, i) => (p.length < PAGE_MIN_CHARS ? i + 1 : 0)).filter(Boolean);
  const cap = opts.muxUp ? MAX_SCANNED_PAGES : MAX_SCANNED_PAGES_OCR;
  const read = new Map<number, TextSegment[]>();
  let failed = 0;
  let noImage = 0;
  let viaOcr = 0;
  for (const n of blank.slice(0, cap)) {
    try {
      const imgs = await extractImages(pdf, n);
      const big = imgs.filter((im) => Math.max(im.width, im.height) >= MIN_SCAN_SIDE).sort((a, b) => b.width * b.height - a.width * a.height)[0];
      if (!big) { noImage++; continue; }
      const png = await encodeRaw(big, VISION_MAX_SIDE);
      if (!png) { failed++; continue; }
      const r = await readPicture(png, "image/png", opts, { hint: `This is page ${n} of a scanned PDF.` });
      if (!r.reader) { failed++; continue; }
      if (r.reader === "tesseract") viaOcr++;
      if (!r.text && !r.description) continue;
      const groups = r.text ? packBlocks(r.blocks) : [];
      const segs: TextSegment[] = groups.map((g) => ({ text: g.text, page: n, at: { image: `page ${n}`, ...(g.region ? { region: g.region } : {}) } }));
      if (!segs.length) segs.push({ text: `Picture: ${r.description}`, page: n, at: { image: `page ${n}` } });
      else if (r.description && n === blank[0]) segs[0] = { ...segs[0], text: `Description: ${r.description}\n\n${segs[0].text}` };
      read.set(n, segs);
      pages[n - 1] = segs.map((s) => s.text).join("\n\n");
    } catch (e) {
      failed++;
      meta.scanError = errText(e);
    }
  }
  if (blank.length) meta.scannedPages = { withoutText: blank.length, read: read.size };
  const unread = blank.length - read.size;
  if (unread > 0) {
    const why = !opts.muxUp ? " (the model gateway, mux, is unreachable, so only a few pages were tried with the fallback reader)" : blank.length > cap ? ` (only the first ${cap} scanned pages are read)` : noImage ? " (they have no picture to read)" : "";
    warnings.push(read.size
      ? `${unread} of ${blank.length} pages without a text layer couldn't be read${why}.`
      : `This PDF has little or no text layer (it may be a scan), and its pages couldn't be read${why}. Only the text it contains was read.`);
  }
  if (viaOcr) warnings.push("Scanned pages were read with the fallback text reader because mux was unreachable. Read it again later for better text.");
  if (failed) meta.scanFailures = failed;

  const segments: TextSegment[] = pages.flatMap((t, i) => read.get(i + 1) ?? [{ text: t, page: i + 1 }]);
  return {
    segments,
    textContent: pages.join("\n\f\n"),
    meta,
    warnings,
    activity: read.size && read.size * 2 >= totalPages ? "ocr" : "upload",
    dates,
  };
}
