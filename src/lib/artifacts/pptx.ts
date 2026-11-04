/**
 * PowerPoint export (pure, no database): a document as a .pptx built with pptxgenjs, styled by its pinned design set.
 *
 *   planSlides(…)  the layout: a cover, then each section on as many 16:9 slides as it needs (blocks are measured
 *                  with conservative text estimates and split between slides: paragraphs, fact rows, timeline items,
 *                  table rows with the header repeated), then the sources. Pure and tested.
 *   buildPptx(…)   draws the plan: light palette colours, the display and body fonts (named in the theme too, with a
 *                  serif/sans pitch family so PowerPoint substitutes the right kind of font where one isn't installed),
 *                  the logo on the cover, the footer and slide numbers. Citations are superscript numbers in the text,
 *                  the slide's sources in its speaker notes, and a numbered Sources list at the end.
 *
 * Decks map one-to-one onto the on-screen slides. Reports, one-pagers, briefs and profiles get the same simple
 * treatment (cover + a slide per section), which is enough to present or hand round.
 */
import PptxGenJS from "pptxgenjs";
import JSZip from "jszip";
import { contrast, fontInfo, mix, type ArtifactKind, type DesignTokens, type KindTemplate, type Palette } from "@/lib/design-sets/tokens";
import { CITE_RE, citationNumbers, citesOfBlock, usedCitations, type ArtifactContent, type Block, type Citation } from "./content";

/* ── Geometry (inches, 16:9 "wide") ──────────────────────────────────────────────────────────────────── */

export const SLIDE_W = 13.333;
export const SLIDE_H = 7.5;
const MX = 0.8;
const CONTENT_W = SLIDE_W - 2 * MX;
const TITLE_Y = 0.5;
const BODY_TOP = 1.72;
/** Space between blocks on a slide. */
const BLOCK_GAP = 0.22;
const BODY_BOTTOM = 6.7;
const GAP = 0.16;

export type PptxLabels = {
  sources: string;
  /** "{n} of {total}" */
  slide: string;
  draft: string;
  /** "{title} (continued)" */
  continued: string;
  /** Speaker notes heading: "Sources on this slide" */
  notesSources: string;
};

export const DEFAULT_PPTX_LABELS: PptxLabels = {
  sources: "Sources", slide: "{n} of {total}", draft: "Draft", continued: "{title} (continued)", notesSources: "Sources on this slide",
};

export type PptxImage = { data: string; mime: string; w: number; h: number };

export type PptxInput = {
  kind: ArtifactKind;
  title: string;
  content: ArtifactContent;
  tokens: DesignTokens;
  template: KindTemplate;
  status: "draft" | "published";
  byline: string;
  labels?: Partial<PptxLabels>;
  /** Images by source id (already read and allowed for the viewer); blocks whose image is missing are left out. */
  images?: Map<string, PptxImage>;
  /** The logo, read from the design set (SVG logos are left out: older PowerPoint can't show them). */
  logo?: PptxImage | null;
  /** Links back to the app for @mentions and the sources list. */
  links?: { node?: (id: string) => string; source?: (id: string) => string };
  author?: string;
  company?: string;
  /** "design" (default): the design set's fonts, with a serif/sans fallback hint. "standard": Arial and Georgia, which every computer has. */
  fonts?: "design" | "standard";
};

/* ── Text measurement (conservative estimates) ───────────────────────────────────────────────────────── */

const MENTION = /@\[([^\]]{1,200})\]\(node:([0-9a-f-]{36})\)/g;

/** Text as a person reads it: mentions become their names, citation markers disappear. */
export function plainText(text: string): string {
  return text.replace(new RegExp(MENTION.source, "g"), "$1").replace(new RegExp(CITE_RE.source, "g"), "").replace(/[ \t]+([.,;:!?])/g, "$1");
}

/** Lines a text takes in a box `w` inches wide at `pt` points (average glyph ≈ 0.52 em, so it errs long). */
export function linesFor(text: string, w: number, pt: number): number {
  const perLine = Math.max(8, Math.floor((w * 72) / (pt * 0.52)));
  return text.split("\n").reduce((n, l) => n + Math.max(1, Math.ceil(l.length / perLine)), 0);
}

const lineH = (pt: number, spacing = 1.2) => (pt * spacing) / 72;

/* ── Plan ────────────────────────────────────────────────────────────────────────────────────────────── */

export type Sizes = { h1: number; h2: number; h3: number; body: number; small: number; quote: number };

export function sizesFor(t: Pick<DesignTokens, "scale">): Sizes {
  const body = 17;
  const s = Math.min(1.6, Math.max(1.1, t.scale));
  return {
    body, small: 12,
    h3: Math.round(Math.min(24, body * s)),
    h2: Math.round(Math.min(34, Math.max(26, body * s ** 3))),
    h1: Math.round(Math.min(54, Math.max(38, body * s ** 4.5))),
    quote: Math.round(Math.min(26, body * s * 1.15)),
  };
}

/** One measured piece of a block. Consecutive pieces of the same block on a slide are drawn together. */
export type Piece =
  | { t: "heading"; blockId: string; text: string; h: number }
  | { t: "para"; blockId: string; text: string; h: number }
  | { t: "facts"; blockId: string; items: Extract<Block, { type: "facts" }>["items"]; h: number }
  | { t: "tl"; blockId: string; item: Extract<Block, { type: "timeline" }>["items"][number]; h: number }
  | { t: "people"; blockId: string; items: Extract<Block, { type: "people" }>["items"]; h: number }
  | { t: "row"; blockId: string; columns: string[]; cells: string[]; cites: string[]; head: boolean; h: number }
  | { t: "quote"; blockId: string; text: string; attribution: string; cites: string[]; h: number }
  | { t: "image"; blockId: string; sourceId: string; caption: string; alt: string; ratio: number; h: number };

export type SlidePlan =
  | { type: "cover" }
  | { type: "section"; sectionId: string; title: string; continued: boolean; pieces: (Piece & { y: number })[] }
  | { type: "sources"; items: (Citation & { n: number })[]; continued: boolean };

const FACT_COLS = 3;
const PEOPLE_COLS = 2;
const TL_WHEN_W = 2.3;

function piecesOf(b: Block, sz: Sizes, images: Map<string, PptxImage>): Piece[] {
  const w = CONTENT_W;
  switch (b.type) {
    case "heading":
      return b.text.trim() ? [{ t: "heading", blockId: b.id, text: b.text.trim(), h: lineH(sz.h3) * linesFor(b.text, w, sz.h3) + 0.08 }] : [];
    case "text":
      return b.text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
        .map((p) => ({ t: "para" as const, blockId: b.id, text: p, h: lineH(sz.body, 1.25) * linesFor(plainText(p), w, sz.body) + 0.12 }));
    case "facts": {
      const out: Piece[] = [];
      const cw = (w - GAP * (FACT_COLS - 1)) / FACT_COLS - 0.3;
      for (let i = 0; i < b.items.length; i += FACT_COLS) {
        const row = b.items.slice(i, i + FACT_COLS);
        const tall = Math.max(...row.map((it) => lineH(sz.small) * linesFor(it.label, cw, sz.small) + lineH(sz.body) * linesFor(plainText(it.value), cw, sz.body)));
        out.push({ t: "facts", blockId: b.id, items: row, h: tall + 0.3 + GAP });
      }
      return out;
    }
    case "timeline":
      return b.items.map((it) => {
        const tw = w - TL_WHEN_W - 0.2;
        const h = lineH(sz.body) * linesFor(plainText(it.label), tw, sz.body) + (it.detail ? lineH(sz.small + 2) * linesFor(plainText(it.detail), tw, sz.small + 2) : 0);
        return { t: "tl" as const, blockId: b.id, item: it, h: h + 0.18 };
      });
    case "people": {
      const out: Piece[] = [];
      for (let i = 0; i < b.items.length; i += PEOPLE_COLS) out.push({ t: "people", blockId: b.id, items: b.items.slice(i, i + PEOPLE_COLS), h: 0.62 + GAP / 2 });
      return out;
    }
    case "table": {
      const cols = Math.max(1, b.columns.length, ...b.rows.map((r) => r.cells.length));
      const cw = w / cols - 0.15;
      const pt = sz.small + 1;
      const rowH = (cells: string[]) => Math.max(...Array.from({ length: cols }, (_, i) => linesFor(plainText(cells[i] ?? ""), cw, pt))) * lineH(pt) + 0.14;
      const out: Piece[] = [];
      if (b.columns.some((c) => c.trim())) out.push({ t: "row", blockId: b.id, columns: b.columns, cells: b.columns, cites: [], head: true, h: rowH(b.columns) });
      for (const r of b.rows) out.push({ t: "row", blockId: b.id, columns: b.columns, cells: r.cells, cites: r.cites, head: false, h: rowH(r.cells) });
      return out;
    }
    case "quote":
      return b.text.trim() ? [{
        t: "quote", blockId: b.id, text: b.text, attribution: b.attribution, cites: b.cites,
        h: lineH(sz.quote, 1.25) * linesFor(plainText(b.text), w - 0.4, sz.quote) + (b.attribution ? 0.4 : 0) + 0.2,
      }] : [];
    case "image": {
      const img = images.get(b.sourceId);
      if (!img || /^0{8}-/.test(b.sourceId)) return [];
      const ratio = img.w > 0 && img.h > 0 ? img.w / img.h : 4 / 3;
      const h = Math.min(4.6, CONTENT_W / ratio) + (b.caption ? 0.4 : 0) + 0.1;
      return [{ t: "image", blockId: b.id, sourceId: b.sourceId, caption: b.caption, alt: b.alt, ratio, h }];
    }
  }
}

/** Lay the document out on slides. Headings keep with what follows; a table's header repeats on every slide it spans. */
export function planSlides(input: Pick<PptxInput, "content" | "tokens" | "images">, opts: { sourcesPerSlide?: number } = {}): SlidePlan[] {
  const sz = sizesFor(input.tokens);
  const images = input.images ?? new Map();
  const slides: SlidePlan[] = [{ type: "cover" }];
  const room = BODY_BOTTOM - BODY_TOP;
  for (const s of input.content.sections) {
    const pieces = s.blocks.flatMap((b) => piecesOf(b, sz, images));
    const titleless = !s.title.trim();
    let cur: Extract<SlidePlan, { type: "section" }> = { type: "section", sectionId: s.id, title: s.title.trim(), continued: false, pieces: [] };
    let y = titleless ? TITLE_Y + 0.2 : BODY_TOP;
    const flush = () => {
      slides.push(cur);
      cur = { type: "section", sectionId: s.id, title: s.title.trim(), continued: true, pieces: [] };
      y = BODY_TOP;
    };
    for (let i = 0; i < pieces.length; i++) {
      const p = pieces[i];
      const h = Math.min(p.h, room);
      const prev = cur.pieces[cur.pieces.length - 1];
      if (prev && prev.blockId !== p.blockId) y += BLOCK_GAP;
      const next = pieces[i + 1];
      // Keep a heading with the first line of what follows.
      const need = p.t === "heading" && next ? h + Math.min(next.h, room / 2) : h;
      if (cur.pieces.length && y + need > BODY_BOTTOM) {
        flush();
        // A table continuing on a new slide gets its header again.
        if (p.t === "row" && !p.head) {
          const head = pieces.slice(0, i).reverse().find((x): x is Extract<Piece, { t: "row" }> => x.t === "row" && x.blockId === p.blockId && x.head);
          if (head) { cur.pieces.push({ ...head, y }); y += head.h; }
        }
      }
      cur.pieces.push({ ...p, h, y });
      y += h;
    }
    if (cur.pieces.length || !cur.continued) slides.push(cur);
  }
  const used = usedCitations(input.content);
  const per = opts.sourcesPerSlide ?? 9;
  for (let i = 0; i < used.length; i += per) slides.push({ type: "sources", items: used.slice(i, i + per), continued: i > 0 });
  return slides;
}

/** Citation ids drawn on a slide, in order (for its speaker notes). */
export function citesOnSlide(slide: SlidePlan): string[] {
  if (slide.type !== "section") return [];
  const ids: string[] = [];
  for (const p of slide.pieces) {
    if (p.t === "para" || p.t === "heading") ids.push(...[...p.text.matchAll(new RegExp(CITE_RE.source, "g"))].map((m) => m[1]));
    else if (p.t === "facts" || p.t === "people") ids.push(...p.items.flatMap((x) => x.cites));
    else if (p.t === "tl") ids.push(...citesOfBlock({ id: "x", type: "timeline", items: [p.item] }));
    else if (p.t === "row" || p.t === "quote") {
      if (p.t === "quote") ids.push(...[...p.text.matchAll(new RegExp(CITE_RE.source, "g"))].map((m) => m[1]));
      ids.push(...p.cites);
    }
  }
  return [...new Set(ids)];
}

/* ── Fonts and colours ───────────────────────────────────────────────────────────────────────────────── */

/** OOXML pitch family for a curated font: 18 = roman (serif substitute), 34 = swiss (sans substitute). */
export function pitchFamily(family: string): 18 | 34 {
  const f = fontInfo(family);
  return f.category === "serif" || (/serif/.test(f.fallback) && !/sans-serif/.test(f.fallback)) ? 18 : 34;
}

/** The everywhere-installed font of the same kind: Georgia for serifs, Arial for the rest. */
export function standardFont(family: string): string {
  return pitchFamily(family) === 18 ? "Georgia" : "Arial";
}

const hx = (c: string) => c.replace(/^#/, "").toUpperCase();

/** Ink on the accent colour: white or the palette's ink, whichever reads better. */
export function onAccent(p: Palette): string {
  return contrast(p.accent, "#ffffff") >= contrast(p.accent, p.ink) ? "#ffffff" : p.ink;
}

/* ── Drawing ─────────────────────────────────────────────────────────────────────────────────────────── */

type Run = PptxGenJS.TextProps;

function interpolate(s: string, vars: Record<string, string | number>): string {
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

type DrawCtx = {
  pres: PptxGenJS; p: Palette; display: string; body: string; sz: Sizes; nums: Map<string, number>;
  links: NonNullable<PptxInput["links"]>; images: Map<string, PptxImage>;
};

/** Text with superscript citation numbers and linked @mentions. */
function runs(ctx: DrawCtx, text: string, base: PptxGenJS.TextPropsOptions = {}, extraCites: string[] = []): Run[] {
  const out: Run[] = [];
  const re = new RegExp(`${CITE_RE.source}|${MENTION.source}`, "g");
  let last = 0;
  const push = (t: string, o: PptxGenJS.TextPropsOptions = {}) => { if (t) out.push({ text: t, options: { ...base, ...o } }); };
  const sup = (cid: string) => {
    const n = ctx.nums.get(cid);
    if (n) push(String(n), { superscript: true, color: hx(ctx.p.accent) });
  };
  for (const m of text.matchAll(re)) {
    push(text.slice(last, m.index).replace(/[ \t]+$/, (s) => (/[.,;:!?]/.test(text[(m.index ?? 0) + m[0].length] ?? "") ? "" : s)));
    if (m[1]) sup(m[1]);
    else if (m[2] && m[3]) {
      const url = ctx.links.node?.(m[3]);
      push(m[2], url ? { hyperlink: { url } } : {});
    }
    last = (m.index ?? 0) + m[0].length;
  }
  push(text.slice(last));
  for (const c of [...new Set(extraCites)]) sup(c);
  if (!out.length) out.push({ text: "", options: base });
  return out;
}

function drawPieces(ctx: DrawCtx, slide: PptxGenJS.Slide, pieces: (Piece & { y: number })[]): void {
  const { p, sz } = ctx;
  for (let i = 0; i < pieces.length; i++) {
    const pc = pieces[i];
    switch (pc.t) {
      case "heading":
        slide.addText(runs(ctx, pc.text), { x: MX, y: pc.y, w: CONTENT_W, h: pc.h, fontFace: ctx.display, fontSize: sz.h3, bold: true, color: hx(p.ink), margin: 0, valign: "top" });
        break;
      case "para": {
        // Consecutive paragraphs of one block: one text box, so it edits like one.
        const group = [pc];
        while (pieces[i + 1]?.t === "para" && pieces[i + 1].blockId === pc.blockId) group.push(pieces[++i] as typeof pc);
        const h = group.reduce((n, g) => n + g.h, 0);
        const all: Run[] = [];
        group.forEach((g, k) => {
          const r = runs(ctx, g.text.replace(/\n/g, " "));
          if (k < group.length - 1) r[r.length - 1] = { ...r[r.length - 1], options: { ...r[r.length - 1].options, breakLine: true } };
          all.push(...r);
        });
        slide.addText(all, { x: MX, y: pc.y, w: CONTENT_W, h, fontFace: ctx.body, fontSize: sz.body, color: hx(p.ink), margin: 0, valign: "top", paraSpaceAfter: 8, lineSpacingMultiple: 1.1 });
        break;
      }
      case "facts": {
        const cw = (CONTENT_W - GAP * (FACT_COLS - 1)) / FACT_COLS;
        pc.items.forEach((it, k) => {
          const x = MX + k * (cw + GAP);
          slide.addShape(ctx.pres.ShapeType.roundRect, { x, y: pc.y, w: cw, h: pc.h - GAP, fill: { color: hx(p.surface) }, line: { color: hx(p.line), width: 0.75 }, rectRadius: 0.08 });
          slide.addText([
            { text: it.label, options: { fontSize: sz.small, color: hx(p.muted), breakLine: true } },
            ...runs(ctx, it.value, { fontSize: sz.body, bold: true, color: hx(p.ink) }, it.cites),
          ], { x: x + 0.15, y: pc.y + 0.1, w: cw - 0.3, h: pc.h - GAP - 0.2, fontFace: ctx.body, margin: 0, valign: "top" });
        });
        break;
      }
      case "tl": {
        slide.addShape(ctx.pres.ShapeType.line, { x: MX, y: pc.y, w: CONTENT_W, h: 0, line: { color: hx(p.line), width: 0.75 } });
        slide.addText(pc.item.when, { x: MX, y: pc.y + 0.08, w: TL_WHEN_W - 0.1, h: pc.h - 0.12, fontFace: ctx.body, fontSize: sz.small + 1, color: hx(p.muted), margin: 0, valign: "top" });
        const body: Run[] = runs(ctx, pc.item.label, { bold: true, fontSize: sz.body, color: hx(p.ink) }, pc.item.cites);
        if (pc.item.detail) {
          body[body.length - 1] = { ...body[body.length - 1], options: { ...body[body.length - 1].options, breakLine: true } };
          body.push(...runs(ctx, pc.item.detail, { fontSize: sz.small + 2, color: hx(p.muted) }));
        }
        slide.addText(body, { x: MX + TL_WHEN_W, y: pc.y + 0.08, w: CONTENT_W - TL_WHEN_W, h: pc.h - 0.12, fontFace: ctx.body, margin: 0, valign: "top" });
        break;
      }
      case "people": {
        const cw = (CONTENT_W - GAP) / PEOPLE_COLS;
        pc.items.forEach((it, k) => {
          const x = MX + k * (cw + GAP);
          const parts = it.name.trim().split(/\s+/).filter(Boolean);
          const ini = ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() || "?";
          slide.addShape(ctx.pres.ShapeType.ellipse, { x, y: pc.y + 0.04, w: 0.5, h: 0.5, fill: { color: hx(mix(p.accent2, p.bg, 0.82)) }, line: { type: "none" } });
          slide.addText(ini, { x, y: pc.y + 0.04, w: 0.5, h: 0.5, align: "center", valign: "middle", fontFace: ctx.display, fontSize: 12, bold: true, color: hx(p.accent2), margin: 0 });
          const url = it.nodeId ? ctx.links.node?.(it.nodeId) : undefined;
          const name: Run[] = [{ text: it.name, options: { bold: true, fontSize: sz.body - 1, color: hx(p.ink), ...(url ? { hyperlink: { url } } : {}) } }];
          for (const c of it.cites) { const n = ctx.nums.get(c); if (n) name.push({ text: String(n), options: { superscript: true, color: hx(p.accent), fontSize: sz.body - 1 } }); }
          if (it.role) { name[name.length - 1].options = { ...name[name.length - 1].options, breakLine: true }; name.push({ text: it.role, options: { fontSize: sz.small, color: hx(p.muted) } }); }
          slide.addText(name, { x: x + 0.62, y: pc.y, w: cw - 0.62, h: 0.58, fontFace: ctx.body, margin: 0, valign: "middle" });
        });
        break;
      }
      case "row": {
        const group = [pc];
        while (pieces[i + 1]?.t === "row" && pieces[i + 1].blockId === pc.blockId) group.push(pieces[++i] as typeof pc);
        const cols = Math.max(1, pc.columns.length, ...group.map((g) => g.cells.length));
        const border = (c: string, pt: number): PptxGenJS.BorderProps => ({ type: "solid", pt, color: hx(c) });
        const rows: PptxGenJS.TableRow[] = group.map((g) => Array.from({ length: cols }, (_, k) => {
          const text = g.cells[k] ?? "";
          const cell: PptxGenJS.TableCell = {
            text: runs(ctx, text, {}, !g.head && k === cols - 1 ? g.cites : []),
            options: g.head
              ? { bold: true, color: hx(p.muted), border: [{ type: "none" }, { type: "none" }, border(p.ink, 1), { type: "none" }] }
              : { color: hx(p.ink), border: [{ type: "none" }, { type: "none" }, border(p.line, 0.75), { type: "none" }] },
          };
          return cell;
        }));
        slide.addTable(rows, {
          x: MX, y: pc.y, w: CONTENT_W, colW: Array.from({ length: cols }, () => CONTENT_W / cols), rowH: group.map((g) => g.h),
          fontFace: ctx.body, fontSize: sz.small + 1, valign: "top", margin: [0.04, 0.08, 0.04, 0],
        });
        break;
      }
      case "quote":
        slide.addShape(ctx.pres.ShapeType.rect, { x: MX, y: pc.y + 0.05, w: 0.06, h: pc.h - 0.25, fill: { color: hx(p.accent) }, line: { type: "none" } });
        slide.addText([
          ...runs(ctx, pc.text, { fontFace: ctx.display, fontSize: sz.quote, color: hx(p.ink) }, pc.cites),
          ...(pc.attribution ? [{ text: "", options: { breakLine: true } }, { text: pc.attribution, options: { fontFace: ctx.body, fontSize: sz.small, color: hx(p.muted) } }] : []),
        ] as Run[], { x: MX + 0.3, y: pc.y, w: CONTENT_W - 0.3, h: pc.h - 0.1, margin: 0, valign: "top", lineSpacingMultiple: 1.1 });
        break;
      case "image": {
        const img = ctx.images.get(pc.sourceId);
        if (!img) break;
        const capH = pc.caption ? 0.4 : 0;
        const maxH = pc.h - capH - 0.1;
        let w = CONTENT_W, h = w / pc.ratio;
        if (h > maxH) { h = maxH; w = h * pc.ratio; }
        slide.addImage({ data: `${img.mime};base64,${img.data}`, x: MX, y: pc.y, w, h, altText: pc.alt || pc.caption || undefined });
        if (pc.caption) slide.addText(pc.caption, { x: MX, y: pc.y + h + 0.06, w: CONTENT_W, h: 0.32, fontFace: ctx.body, fontSize: sz.small, color: hx(p.muted), margin: 0, valign: "top" });
        break;
      }
    }
  }
}

function citationLine(c: Citation & { n: number }): string {
  return `${c.n}. ${c.label}${c.locator ? ` (${c.locator})` : ""}${c.quote ? ` — “${c.quote}”` : ""}`;
}

/** Build the .pptx. Returns the file as bytes. */
export async function buildPptx(input: PptxInput): Promise<Buffer> {
  const labels = { ...DEFAULT_PPTX_LABELS, ...(input.labels ?? {}) };
  const t = input.tokens;
  const p = t.colors.light;
  const standard = input.fonts === "standard";
  const display = standard ? standardFont(t.fonts.display) : fontInfo(t.fonts.display).family;
  const body = standard ? standardFont(t.fonts.body) : fontInfo(t.fonts.body).family;
  const sz = sizesFor(t);
  const images = input.images ?? new Map<string, PptxImage>();
  const plan = planSlides({ content: input.content, tokens: t, images });
  const total = plan.length;
  const nums = citationNumbers(input.content);
  const byId = new Map(input.content.citations.map((c) => [c.id, c]));

  const pres = new PptxGenJS();
  pres.layout = "LAYOUT_WIDE";
  pres.title = input.title;
  if (input.author) pres.author = input.author;
  if (input.company) pres.company = input.company;
  pres.subject = input.content.subtitle || input.title;
  pres.theme = { headFontFace: display, bodyFontFace: body };
  const ctx: DrawCtx = { pres, p, display, body, sz, nums, links: input.links ?? {}, images };

  const chrome = (slide: PptxGenJS.Slide, n: number, onColor?: string) => {
    const col = hx(onColor ?? p.muted);
    slide.addText(interpolate(labels.slide, { n, total }), { x: SLIDE_W - MX - 2, y: SLIDE_H - 0.55, w: 2, h: 0.3, align: "right", fontFace: body, fontSize: 10, color: col, margin: 0 });
    if (input.template.footer) slide.addText(input.template.footer, { x: MX, y: SLIDE_H - 0.55, w: CONTENT_W - 2.2, h: 0.3, fontFace: body, fontSize: 10, color: col, margin: 0 });
  };

  plan.forEach((sp, idx) => {
    const n = idx + 1;
    const slide = pres.addSlide();
    slide.background = { color: hx(p.bg) };
    if (sp.type === "cover") {
      const band = input.template.cover === "band";
      const ink = band ? onAccent(p) : p.ink;
      const soft = band ? mix(onAccent(p), p.accent, 0.2) : p.muted;
      if (band) slide.background = { color: hx(p.accent) };
      if (input.logo && input.template.showLogo) {
        const lh = 0.6, lw = Math.min(2.6, lh * (input.logo.w / Math.max(1, input.logo.h)));
        slide.addImage({ data: `${input.logo.mime};base64,${input.logo.data}`, x: MX, y: 0.6, w: lw, h: lw / (input.logo.w / Math.max(1, input.logo.h)), altText: t.logo?.alt || undefined });
      }
      const titleLines = linesFor(input.title, CONTENT_W, sz.h1);
      const titleH = lineH(sz.h1, 1.05) * titleLines + 0.1;
      const subH = input.content.subtitle ? lineH(22) * linesFor(input.content.subtitle, CONTENT_W, 22) + 0.1 : 0;
      const bottom = SLIDE_H - 1.0;
      const byY = bottom - 0.4;
      const subY = byY - subH - 0.1;
      const titleY = Math.max(1.4, subY - titleH);
      if (input.template.cover === "rule") slide.addShape(pres.ShapeType.rect, { x: MX, y: titleY - 0.35, w: CONTENT_W, h: 0.09, fill: { color: hx(p.ink) }, line: { type: "none" } });
      if (input.status === "draft") {
        slide.addText(labels.draft, { x: MX, y: titleY - (input.template.cover === "rule" ? 0.85 : 0.55), w: 1.1, h: 0.32, shape: pres.ShapeType.roundRect, rectRadius: 0.16, fill: { color: hx(band ? mix(p.accent, "#ffffff", 0.85) : mix(p.accent, p.bg, 0.85)) }, color: hx(p.accent), fontFace: body, fontSize: 11, align: "center", valign: "middle", margin: 0 });
      }
      slide.addText(input.title, { x: MX, y: titleY, w: CONTENT_W, h: titleH, fontFace: display, fontSize: sz.h1, bold: true, color: hx(ink), margin: 0, valign: "bottom", lineSpacingMultiple: 0.95 });
      if (input.content.subtitle) slide.addText(input.content.subtitle, { x: MX, y: subY, w: CONTENT_W, h: subH, fontFace: body, fontSize: 22, color: hx(soft), margin: 0, valign: "top" });
      if (input.byline) slide.addText(input.byline, { x: MX, y: byY, w: CONTENT_W, h: 0.35, fontFace: body, fontSize: 13, color: hx(soft), margin: 0 });
      chrome(slide, n, band ? soft : undefined);
      return;
    }
    if (sp.type === "section") {
      if (sp.title) {
        slide.addText(sp.continued ? interpolate(labels.continued, { title: sp.title }) : sp.title, {
          x: MX, y: TITLE_Y, w: CONTENT_W, h: 0.85, fontFace: display, fontSize: sz.h2, bold: true, color: hx(p.ink), margin: 0, valign: "bottom", fit: "shrink",
        });
        slide.addShape(pres.ShapeType.rect, { x: MX, y: TITLE_Y + 0.92, w: 0.7, h: 0.05, fill: { color: hx(p.accent) }, line: { type: "none" } });
      }
      drawPieces(ctx, slide, sp.pieces);
      const cited = citesOnSlide(sp).map((cid) => byId.get(cid)).filter((c): c is Citation => !!c)
        .map((c) => ({ ...c, n: nums.get(c.id) ?? 0 })).filter((c) => c.n > 0).sort((a, b) => a.n - b.n);
      if (cited.length) slide.addNotes(`${labels.notesSources}:\n${cited.map(citationLine).join("\n")}`);
      chrome(slide, n);
      return;
    }
    // Sources
    slide.addText(sp.continued ? interpolate(labels.continued, { title: labels.sources }) : labels.sources, { x: MX, y: TITLE_Y, w: CONTENT_W, h: 0.85, fontFace: display, fontSize: sz.h2, bold: true, color: hx(p.ink), margin: 0, valign: "bottom" });
    const list: Run[] = [];
    sp.items.forEach((c, k) => {
      const url = c.kind === "source" && c.sourceId ? input.links?.source?.(c.sourceId) : c.nodeId ? input.links?.node?.(c.nodeId) : c.sourceId ? input.links?.source?.(c.sourceId) : undefined;
      list.push({ text: `${c.n}  `, options: { color: hx(p.accent), bold: true } });
      list.push({ text: c.label, options: { color: hx(p.ink), ...(url ? { hyperlink: { url } } : {}) } });
      if (c.locator) list.push({ text: `  ${c.locator}`, options: { color: hx(p.muted) } });
      if (c.quote) {
        list[list.length - 1].options = { ...list[list.length - 1].options, breakLine: true };
        list.push({ text: `“${c.quote.slice(0, 220)}${c.quote.length > 220 ? "…" : ""}”`, options: { color: hx(p.muted), italic: true, fontSize: sz.small } });
      }
      if (k < sp.items.length - 1) list[list.length - 1].options = { ...list[list.length - 1].options, breakLine: true };
    });
    slide.addText(list, { x: MX, y: BODY_TOP, w: CONTENT_W, h: BODY_BOTTOM - BODY_TOP, fontFace: body, fontSize: sz.small + 2, margin: 0, valign: "top", paraSpaceAfter: 6 });
    slide.addNotes(sp.items.map(citationLine).join("\n"));
    chrome(slide, n);
  });

  const raw = (await pres.write({ outputType: "nodebuffer" })) as Buffer;
  return standard ? raw : withFontFallbacks(raw, [display, body]);
}

/**
 * Give the design fonts the right pitch family everywhere they are named (pptxgenjs marks every font as sans), so a
 * computer without, say, Fraunces shows a serif rather than Calibri.
 */
async function withFontFallbacks(buf: Buffer, families: string[]): Promise<Buffer> {
  const serif = [...new Set(families)].filter((f) => pitchFamily(f) === 18);
  const zip = await JSZip.loadAsync(buf);
  const names = Object.keys(zip.files).filter((n) => /^ppt\/(slides\/slide\d+|theme\/theme\d+|slideMasters\/slideMaster\d+|slideLayouts\/slideLayout\d+)\.xml$/.test(n));
  for (const name of names) {
    const xml = await zip.file(name)!.async("string");
    const next = xml.replace(/<a:latin typeface="([^"]+)"[^>]*\/>/g, (m, face: string) => {
      const f = families.find((x) => x === face);
      if (!f) return m;
      return `<a:latin typeface="${face}" pitchFamily="${serif.includes(f) ? 18 : 34}" charset="0"/>`;
    });
    if (next !== xml) zip.file(name, next);
  }
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

/* ── Image sizes ─────────────────────────────────────────────────────────────────────────────────────── */

/** Pixel size of a PNG, JPEG, GIF or WebP from its header; null when it can't be read. */
export function imageSize(b: Uint8Array): { w: number; h: number } | null {
  const u16 = (i: number) => (b[i] << 8) | b[i + 1];
  const u32 = (i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
  const le16 = (i: number) => b[i] | (b[i + 1] << 8);
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { w: u32(16), h: u32(20) };
  if (b.length > 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return { w: le16(6), h: le16(8) };
  if (b.length > 30 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45) {
    const tag = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (tag === "VP8 ") return { w: le16(26) & 0x3fff, h: le16(28) & 0x3fff };
    if (tag === "VP8L") { const v = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24); return { w: (v & 0x3fff) + 1, h: ((v >> 14) & 0x3fff) + 1 }; }
    if (tag === "VP8X") return { w: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), h: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
    return null;
  }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { w: u16(i + 7), h: u16(i + 5) };
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
      i += 2 + u16(i + 2);
    }
  }
  return null;
}

/** A data: URI image (the design set's logo) as a PptxImage; SVG and unreadable images give null. */
export function dataUriImage(src: string): PptxImage | null {
  const m = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/i.exec(src);
  if (!m) return null;
  const size = imageSize(Buffer.from(m[2], "base64"));
  return size ? { mime: m[1].toLowerCase(), data: m[2], ...size } : null;
}

