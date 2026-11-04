/**
 * Tesseract, the fallback reader for pictures when mux (vision) is unreachable. Server-only.
 * The English and Danish language data ship with the app (assets/tesseract/*.traineddata.gz, LSTM "best_int"), so
 * nothing is downloaded at run time; TESSERACT_LANG_PATH points elsewhere if needed. One worker per picture, ended
 * right after, and pictures are scaled down first, so memory stays bounded.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { loadSharp, OCR_MAX_SIDE, prepareImage } from "./image-prep";
import { withTimeout } from "./types";

export const OCR_LANGS = ["eng", "dan"] as const;
const OCR_TIMEOUT_MS = 90_000;

export type OcrBlock = { text: string; bbox: [number, number, number, number] };
export type OcrResult = { text: string; blocks: OcrBlock[]; confidence: number };

/** Where the bundled language data is. */
export function tesseractLangPath(): string {
  const candidates = [process.env.TESSERACT_LANG_PATH, path.join(process.cwd(), "assets", "tesseract")].filter((p): p is string => !!p);
  return candidates.find((p) => OCR_LANGS.every((l) => existsSync(path.join(p, `${l}.traineddata.gz`)))) ?? candidates[candidates.length - 1];
}

/** Tesseract makes up noise on photos without text: keep only text with real words and fair confidence. */
export function keepOcrText(text: string, confidence: number): boolean {
  const words = text.split(/\s+/).filter((w) => /[\p{L}]{3,}/u.test(w));
  return confidence >= 45 && words.length >= 3;
}

export async function ocrImage(bytes: Buffer, mime: string): Promise<OcrResult> {
  const langPath = tesseractLangPath();
  if (!OCR_LANGS.every((l) => existsSync(path.join(langPath, `${l}.traineddata.gz`)))) {
    throw new Error(`The text reader's language data is missing (looked in ${langPath}).`);
  }
  const prepared = await prepareImage(bytes, mime, { maxSide: OCR_MAX_SIDE, maxBytes: 40 * 1024 * 1024, grayscale: true });
  if (!prepared) throw new Error("This picture format can't be read for text without the model gateway.");
  const { createWorker, OEM } = await import("tesseract.js");
  const worker = await createWorker([...OCR_LANGS], OEM.LSTM_ONLY, { langPath, gzip: true, cacheMethod: "none", logger: () => {} });
  try {
    const r = await withTimeout(worker.recognize(prepared.bytes, {}, { text: true, blocks: true }), OCR_TIMEOUT_MS, "Reading text in the picture");
    const text = r.data.text.replace(/[ \t]+\n/g, "\n").trim();
    if (!keepOcrText(text, r.data.confidence)) return { text: "", blocks: [], confidence: r.data.confidence };
    // Block boxes are in the scaled picture's pixels; scale them back to the original's.
    const scale = prepared.width && prepared.converted ? await originalScale(bytes, prepared.width) : 1;
    const blocks = (r.data.blocks ?? [])
      .map((b) => ({
        text: b.text.replace(/[ \t]+\n/g, "\n").trim(),
        bbox: [b.bbox.x0, b.bbox.y0, b.bbox.x1 - b.bbox.x0, b.bbox.y1 - b.bbox.y0].map((n) => Math.round(n * scale)) as OcrBlock["bbox"],
      }))
      .filter((b) => b.text && b.bbox[2] > 0 && b.bbox[3] > 0);
    return { text, blocks, confidence: r.data.confidence };
  } finally {
    await worker.terminate().catch(() => {});
  }
}

async function originalScale(bytes: Buffer, scaledWidth: number): Promise<number> {
  try {
    const sharp = await loadSharp();
    const m = sharp ? await sharp(bytes).rotate().metadata() : null;
    const w = m?.autoOrient?.width ?? m?.width;
    return w && scaledWidth ? w / scaledWidth : 1;
  } catch {
    return 1;
  }
}
