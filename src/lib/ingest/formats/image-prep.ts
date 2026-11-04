/**
 * Getting pictures ready for a reader. Server-only. Uses sharp (libvips) when it loads: turns photos upright from
 * their EXIF orientation, converts what models and tesseract can't take (TIFF, GIF, HEIC where libvips can decode it)
 * and scales large pictures down. Without sharp, the original bytes are passed through when they are small enough.
 */

/** Longest side sent to the vision model. Slides and screenshots stay legible at this size. */
export const VISION_MAX_SIDE = 2048;
/** Longest side given to tesseract: bigger pictures cost a lot of memory and rarely read better. */
export const OCR_MAX_SIDE = 2600;
/** The vision model takes the picture inline (base64); beyond this it is refused or slow. */
export const VISION_MAX_BYTES = 8 * 1024 * 1024;

/** Formats a vision model and tesseract take as they are. */
const PASSTHROUGH = new Set(["image/jpeg", "image/png", "image/webp"]);

export type PreparedImage = { bytes: Buffer; mime: string; width: number | null; height: number | null; converted: boolean };

type Sharp = typeof import("sharp").default;
let sharpLoad: Promise<Sharp | null> | null = null;

/** sharp, or null when its native library isn't available on this machine. */
export function loadSharp(): Promise<Sharp | null> {
  sharpLoad ??= import("sharp")
    .then((m) => {
      const s = (m.default ?? m) as Sharp;
      // Keep memory flat on a small server: no operation cache, one libvips thread per call.
      s.cache(false);
      s.concurrency(1);
      return s;
    })
    .catch(() => null);
  return sharpLoad;
}

/**
 * Scale a picture to fit `maxSide`, upright, as PNG (screenshots, slides: crisp text) or JPEG (photos). Returns null
 * when the picture can't be decoded here (e.g. HEIC without a HEVC decoder) and can't be passed through as it is.
 */
export async function prepareImage(bytes: Buffer, mime: string, opts: { maxSide: number; maxBytes?: number; grayscale?: boolean }): Promise<PreparedImage | null> {
  const maxBytes = opts.maxBytes ?? VISION_MAX_BYTES;
  const sharp = await loadSharp();
  if (sharp) {
    try {
      const img = sharp(bytes, { failOn: "none", limitInputPixels: 120_000_000 }).rotate();
      const info = await img.metadata();
      const w = info.autoOrient?.width ?? info.width ?? null;
      const h = info.autoOrient?.height ?? info.height ?? null;
      const big = !!w && !!h && Math.max(w, h) > opts.maxSide;
      const keep = PASSTHROUGH.has(mime) && !big && !opts.grayscale && bytes.byteLength <= maxBytes && (info.orientation ?? 1) === 1;
      if (keep) return { bytes, mime, width: w, height: h, converted: false };
      let pipe = img.resize({ width: opts.maxSide, height: opts.maxSide, fit: "inside", withoutEnlargement: true });
      // For tesseract: grey, and a print resolution so it doesn't guess one.
      if (opts.grayscale) pipe = pipe.grayscale().withMetadata({ density: 300 });
      // Photos compress far better as JPEG; drawn pictures (PNG, GIF) keep their sharp edges as PNG.
      const asPng = mime === "image/png" || mime === "image/gif" || opts.grayscale;
      const out = asPng ? await pipe.png({ compressionLevel: 8 }).toBuffer({ resolveWithObject: true }) : await pipe.jpeg({ quality: 88, mozjpeg: true }).toBuffer({ resolveWithObject: true });
      let data = out.data;
      let outMime = asPng ? "image/png" : "image/jpeg";
      if (data.byteLength > maxBytes) {
        data = await sharp(data).jpeg({ quality: 80 }).toBuffer();
        outMime = "image/jpeg";
      }
      return { bytes: data, mime: outMime, width: out.info.width, height: out.info.height, converted: true };
    } catch {
      // fall through: not decodable here
    }
  }
  if (PASSTHROUGH.has(mime) && bytes.byteLength <= maxBytes) return { bytes, mime, width: null, height: null, converted: false };
  return null;
}

/** Raw pixels (e.g. an image pulled out of a PDF page) as a PNG, scaled to fit `maxSide`. Null without sharp. */
export async function encodeRaw(px: { data: Uint8ClampedArray | Uint8Array; width: number; height: number; channels: 1 | 2 | 3 | 4 }, maxSide: number): Promise<Buffer | null> {
  const sharp = await loadSharp();
  if (!sharp) return null;
  try {
    return await sharp(Buffer.from(px.data.buffer, px.data.byteOffset, px.data.byteLength), { raw: { width: px.width, height: px.height, channels: px.channels } })
      .resize({ width: maxSide, height: maxSide, fit: "inside", withoutEnlargement: true })
      .png({ compressionLevel: 8 })
      .toBuffer();
  } catch {
    return null;
  }
}

/** The mime type of picture bytes from their first bytes, for images found inside other files. */
export function sniffImageMime(b: Uint8Array): string | null {
  const at = (i: number, s: string) => s.split("").every((c, j) => b[i + j] === c.charCodeAt(0));
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x89 && at(1, "PNG")) return "image/png";
  if (at(0, "GIF8")) return "image/gif";
  if (at(0, "RIFF") && at(8, "WEBP")) return "image/webp";
  if ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a) || (b[0] === 0x4d && b[1] === 0x4d && b[3] === 0x2a)) return "image/tiff";
  if (at(0, "BM")) return "image/bmp";
  if (at(4, "ftyp")) return "image/heic";
  return null;
}
