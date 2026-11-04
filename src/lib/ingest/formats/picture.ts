/**
 * Read one picture (a photo, a screenshot, a picture on a slide, a scanned PDF page): mux's vision route first, and
 * tesseract (bundled English + Danish) only when mux is unreachable or the vision call fails. Server-only.
 */
import { prepareImage, VISION_MAX_SIDE } from "./image-prep";
import { keepOcrText, ocrImage } from "./ocr";
import { errText, type ReadContext } from "./types";
import { readWithVision, visionText, type PictureKind } from "./vision";

export type PictureBlock = { text: string; region?: string; bbox?: [number, number, number, number] };

export type PictureReading = {
  reader: "vision" | "tesseract" | null;
  kind: PictureKind | null;
  description: string;
  language: string | null;
  blocks: PictureBlock[];
  /** The visible text, in reading order. */
  text: string;
  model: string | null;
  /** What happened, in words people can act on ("done", "skipped: mux unreachable", "failed: …"). */
  vision: string;
  ocr: string;
  width: number | null;
  height: number | null;
};

export async function readPicture(bytes: Buffer, mime: string, ctx: ReadContext, opts: { hint?: string; allowOcr?: boolean } = {}): Promise<PictureReading> {
  const out: PictureReading = { reader: null, kind: null, description: "", language: null, blocks: [], text: "", model: null, vision: "", ocr: "not needed", width: null, height: null };

  if (!ctx.muxUp) out.vision = "skipped: mux unreachable";
  else {
    // Scale down and convert (HEIC, TIFF, GIF) where possible; a HEIC that can't be converted goes as it is.
    const img = (await prepareImage(bytes, mime, { maxSide: VISION_MAX_SIDE })) ?? (mime === "image/heic" && bytes.byteLength <= 8 * 1024 * 1024 ? { bytes, mime, width: null, height: null, converted: false } : null);
    if (!img) out.vision = "skipped: the picture is too large or in a format that can't be converted";
    else {
      out.width = img.width;
      out.height = img.height;
      try {
        const r = await readWithVision(img, ctx.muxMeta, opts.hint);
        out.reader = "vision";
        out.kind = r.kind;
        out.description = r.description;
        out.language = r.language;
        out.model = r.model;
        out.blocks = r.blocks.map((b) => ({ text: b.text, ...(b.region ? { region: b.region } : {}) }));
        out.text = visionText(r);
        out.vision = out.text ? "done" : "no text found";
      } catch (e) {
        out.vision = `failed: ${errText(e)}`;
      }
    }
  }

  if (out.reader === null && opts.allowOcr !== false) {
    if (mime === "image/heic") out.ocr = "skipped: HEIC photos can only be read by the vision model";
    else {
      try {
        const r = await ocrImage(bytes, mime);
        if (r.text && keepOcrText(r.text, r.confidence)) {
          out.reader = "tesseract";
          out.text = r.text;
          out.blocks = r.blocks.length ? r.blocks : [{ text: r.text }];
          out.ocr = "done";
        } else out.ocr = "no text found";
      } catch (e) {
        out.ocr = `failed: ${errText(e)}`;
      }
    }
  }
  return out;
}

/**
 * Pack a picture's blocks into segments of at most ~`max` characters, so each chunk keeps a region (vision) or a
 * bounding box (tesseract) in its locator. One block that fits keeps its own region/box.
 */
export function packBlocks(blocks: PictureBlock[], max = 1100): { text: string; region?: string; bbox?: [number, number, number, number] }[] {
  const out: { text: string; regions: string[]; boxes: [number, number, number, number][] }[] = [];
  for (const b of blocks) {
    const last = out[out.length - 1];
    if (last && last.text.length + b.text.length + 2 <= max) {
      last.text += `\n\n${b.text}`;
      if (b.region) last.regions.push(b.region);
      if (b.bbox) last.boxes.push(b.bbox);
    } else out.push({ text: b.text, regions: b.region ? [b.region] : [], boxes: b.bbox ? [b.bbox] : [] });
  }
  return out.map((g) => ({
    text: g.text,
    ...(g.regions.length ? { region: (g.regions.length > 2 ? `${g.regions[0]} … ${g.regions[g.regions.length - 1]}` : g.regions.join(", ")).slice(0, 120) } : {}),
    ...(g.boxes.length ? { bbox: union(g.boxes) } : {}),
  }));
}

function union(boxes: [number, number, number, number][]): [number, number, number, number] {
  const x0 = Math.min(...boxes.map((b) => b[0]));
  const y0 = Math.min(...boxes.map((b) => b[1]));
  const x1 = Math.max(...boxes.map((b) => b[0] + b[2]));
  const y1 = Math.max(...boxes.map((b) => b[1] + b[3]));
  return [x0, y0, x1 - x0, y1 - y0];
}
