/**
 * Reading a picture through mux's "vision" route: the visible text word for word in its own language, laid out as
 * lines and bullets, plus a short description of what the picture is. Server-only (the parser is pure).
 */
import { z } from "zod";
import * as mux from "@/lib/mux";

export const PICTURE_KINDS = ["slide", "diagram", "chart", "document", "screenshot", "handwriting", "photo", "other"] as const;
export type PictureKind = (typeof PICTURE_KINDS)[number];

export type VisionBlock = { region: string | null; text: string };
export type VisionRead = { kind: PictureKind; description: string; language: string | null; blocks: VisionBlock[] };

const SYSTEM = `You read pictures for a family's private archive so they can be searched and cited. Answer with one JSON object only.

{
  "kind": "slide" | "diagram" | "chart" | "document" | "screenshot" | "handwriting" | "photo" | "other",
  "description": "1–3 plain sentences: what the picture is and shows (e.g. 'A slide titled … with five bullet points about …', 'A flow diagram from … to …', 'A photo of a printed letter from …'). No guesses at people's names.",
  "language": "ISO 639-1 code of the visible text, e.g. \\"da\\", or null when there is no text",
  "blocks": [ { "region": "where it sits, a few words: title, top left, left column, box 2, footer, …", "text": "the text in that region" } ]
}

Rules for "blocks":
- Copy every piece of legible text EXACTLY as written, in its original language. Danish stays Danish: keep æ, ø, å and the spelling as it is. Never translate, correct, summarise or paraphrase.
- Reading order: top to bottom, left to right; a title first.
- Keep the layout: one line per line of text; bullets as "- " (indent sub-bullets by two spaces per level); numbered lists as written; a table as markdown rows ("| a | b |").
- Diagrams: each box or label as its own block; write a visible connection as "A → B".
- Text you can't make out: write [unreadable]. Never invent text that isn't there.
- No visible text: "blocks": [].
- Write "description" in the language of the visible text (English when there is none).`;

const looseString = z.preprocess((v) => (v === null || v === undefined ? "" : typeof v === "string" ? v : String(v)), z.string());

const Block = z.union([
  z.string().transform((text) => ({ region: null, text })),
  z.object({ region: z.unknown().optional(), text: looseString }).transform((b) => ({
    region: typeof b.region === "string" && b.region.trim() ? b.region.trim().slice(0, 80) : null,
    text: b.text,
  })),
]);

const VisionJson = z.object({
  kind: z.unknown().optional(),
  description: looseString.optional(),
  language: z.unknown().optional(),
  blocks: z.array(Block).optional(),
  /** Some models answer with one text field instead of blocks. */
  text: looseString.optional(),
});

/** Validate and tidy the model's answer. Throws when it isn't the asked-for object (completeJson then retries). */
export function parseVisionRead(v: unknown): VisionRead {
  const p = VisionJson.parse(v);
  const kind = (PICTURE_KINDS as readonly string[]).includes(String(p.kind)) ? (p.kind as PictureKind) : "other";
  let blocks = (p.blocks ?? []).map((b) => ({ ...b, text: tidy(b.text) })).filter((b) => b.text && !/^\[unreadable\]$/i.test(b.text));
  if (!blocks.length && p.text?.trim()) blocks = [{ region: null, text: tidy(p.text) }];
  const language = typeof p.language === "string" && /^[a-z]{2,3}$/i.test(p.language.trim()) ? p.language.trim().toLowerCase() : null;
  return { kind, description: (p.description ?? "").trim().slice(0, 800), language, blocks };
}

const tidy = (s: string) => s.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

/** The visible text of a reading, in order. */
export const visionText = (r: VisionRead) => r.blocks.map((b) => b.text).join("\n\n");

/** The JSON object in a model answer (fenced, or with words around it). */
export function looseJson(text: string): unknown {
  let t = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (fence) t = fence[1].trim();
  try {
    return JSON.parse(t);
  } catch {
    const start = t.indexOf("{");
    const end = t.lastIndexOf("}");
    if (start < 0 || end <= start) throw new SyntaxError("The answer contained no JSON object.");
    return JSON.parse(t.slice(start, end + 1));
  }
}

/** One vision call (plus one retry through completeJson if the answer isn't usable). `hint` says where the picture came from. */
export async function readWithVision(img: { bytes: Buffer; mime: string }, meta: mux.MuxCallMeta, hint?: string): Promise<VisionRead & { model: string | null }> {
  const url = `data:${img.mime};base64,${img.bytes.toString("base64")}`;
  const messages: mux.MuxMessage[] = [
    { role: "system", content: SYSTEM },
    {
      role: "user",
      content: [
        { type: "text", text: `${hint ? `${hint}\n` : ""}Read this picture. Answer with the JSON object only.` },
        { type: "image_url", image_url: { url } },
      ],
    },
  ];
  const first = await mux.complete({ route: "vision", maxTokens: 4096, temperature: 0, json: true, meta, messages });
  try {
    return { ...parseVisionRead(looseJson(first.text)), model: first.model };
  } catch {
    const again = await mux.completeJson({ route: "vision", maxTokens: 4096, meta, messages, parse: parseVisionRead });
    return { ...again, model: first.model };
  }
}
