/**
 * The artifact renderer (pure): one HTML renderer per kind, driven entirely by a design set's tokens. The same
 * output is used for the in-app preview, the print route (PDF through the browser) and the HTML download, so what a
 * person sees is what they export. Every piece of text is escaped here; nothing in content is ever treated as HTML.
 */
import { fontStack, googleFontsHref, mix, type ArtifactKind, type DesignTokens, type KindTemplate, type Palette } from "@/lib/design-sets/tokens";
import { CITE_RE, citationNumbers, usedCitations, type ArtifactContent, type Block, type Citation, type Section } from "./content";

export type RenderLabels = {
  sources: string;
  noSources: string;
  contents: string;
  slide: string; // "Slide {n} of {total}" with {n} {total}
  people: string;
  draft: string;
};

export const DEFAULT_LABELS: RenderLabels = {
  sources: "Sources", noSources: "No sources cited yet.", contents: "Contents", slide: "Slide {n} of {total}", people: "People", draft: "Draft",
};

export type RenderInput = {
  kind: ArtifactKind;
  title: string;
  content: ArtifactContent;
  tokens: DesignTokens;
  template: KindTemplate;
  status?: "draft" | "published";
  /** Shown under the title: "Made by Sara for Family, 4 November 2026". */
  byline?: string;
  labels?: Partial<RenderLabels>;
  links?: {
    node?: (nodeId: string) => string | null;
    source?: (sourceId: string) => string | null;
    image?: (sourceId: string) => string;
  };
  /** auto follows the reader's system (and the app's data-theme); light/dark force one. */
  theme?: "auto" | "light" | "dark";
  /** CSS scope suffix, so two previews on one page don't clash. */
  scope?: string;
  /** standalone = a full HTML document (download); print = page-sized; screen = in the app. */
  mode?: "screen" | "print" | "standalone";
};

export type Rendered = { css: string; html: string; fontsHref: string; className: string };

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export function esc(s: string): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);
}

/** Only same-app paths and http(s) links are ever put in an href. */
function safeHref(h: string | null | undefined): string | null {
  if (!h) return null;
  if (h.startsWith("/") && !h.startsWith("//")) return h;
  if (/^https?:\/\//i.test(h)) return h;
  if (h.startsWith("#")) return h;
  return null;
}

function interpolate(s: string, vars: Record<string, string | number>): string {
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

const MENTION = /@\[([^\]]{1,200})\]\(node:([0-9a-f-]{36})\)/g;

const SPACE = { compact: 0.8, comfortable: 1, airy: 1.3 } as const;

function paletteVars(p: Palette): string {
  return [
    `--a-bg:${p.bg}`, `--a-surface:${p.surface}`, `--a-ink:${p.ink}`, `--a-muted:${p.muted}`, `--a-accent:${p.accent}`,
    `--a-accent2:${p.accent2}`, `--a-line:${p.line}`, `--a-accent-tint:${mix(p.bg, p.accent, 0.1)}`, `--a-accent2-tint:${mix(p.bg, p.accent2, 0.14)}`,
    `--a-on-accent:${onColor(p.accent, p)}`,
  ].join(";");
}

function onColor(accent: string, p: Palette): string {
  // Text on an accent band: whichever of bg / ink reads better.
  const lum = (h: string) => {
    const n = parseInt(h.slice(1), 16);
    return ((n >> 16) & 255) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.114;
  };
  return lum(accent) > 150 ? (lum(p.ink) < lum(p.bg) ? p.ink : p.bg) : (lum(p.bg) > lum(p.ink) ? p.bg : p.ink);
}

function buildCss(sc: string, t: DesignTokens, kind: ArtifactKind, theme: "auto" | "light" | "dark", mode: "screen" | "print" | "standalone"): string {
  const root = `.${sc}`;
  const s = SPACE[t.spacing];
  const base = t.baseSize;
  const size = (step: number) => `${(base * t.scale ** step).toFixed(2)}px`;
  const light = paletteVars(t.colors.light);
  const dark = paletteVars(t.colors.dark);
  const vars =
    theme === "light" ? `${root}{${light}}`
    : theme === "dark" ? `${root}{${dark}}`
    : `${root}{${light}}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]) ${root}{${dark}}}
[data-theme="dark"] ${root}{${dark}}`;
  const gap = (n: number) => `${(n * s).toFixed(2)}rem`;
  const r = `${t.radius}px`;
  const display = fontStack(t.fonts.display);
  const body = fontStack(t.fonts.body);
  const deck = kind === "deck";
  const css = `${vars}
${root}{--a-gap:${gap(1)};--a-radius:${r};background:var(--a-bg);color:var(--a-ink);font-family:${body};font-size:${base}px;line-height:1.6;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
${root} *{box-sizing:border-box}
${root} a{color:var(--a-accent);text-decoration:none}
${root} a:hover{text-decoration:underline}
${root} h1,${root} h2,${root} h3{font-family:${display};font-weight:650;line-height:1.15;letter-spacing:-0.015em;margin:0;color:var(--a-ink)}
${root} p{margin:0 0 ${gap(0.8)}}
${root} .a-page{max-width:${kind === "one_pager" ? "900px" : kind === "brief" ? "680px" : "760px"};margin:0 auto;padding:${gap(3)} ${gap(2)} ${gap(4)}}
${root} .a-cover{margin-bottom:${gap(2.5)}}
${root} .a-cover h1{font-size:${size(kind === "brief" ? 3 : 4)};margin-bottom:${gap(0.6)}}
${root} .a-sub{font-size:${size(1)};color:var(--a-muted);margin:0 0 ${gap(0.6)};line-height:1.4}
${root} .a-by{font-size:${size(-1)};color:var(--a-muted)}
${root} .a-logo{display:block;max-height:40px;max-width:180px;object-fit:contain;margin-bottom:${gap(1.5)}}
${root} .a-cover.band{background:var(--a-accent);color:var(--a-on-accent);padding:${gap(2.2)} ${gap(2)};border-radius:var(--a-radius);margin-left:-${gap(0.5)};margin-right:-${gap(0.5)}}
${root} .a-cover.band h1,${root} .a-cover.band .a-sub,${root} .a-cover.band .a-by{color:var(--a-on-accent)}
${root} .a-cover.band .a-sub,${root} .a-cover.band .a-by{opacity:.85}
${root} .a-cover.rule{border-top:6px solid var(--a-ink);padding-top:${gap(1.2)}}
${root} .a-badge{display:inline-block;font-size:12px;padding:1px 8px;border-radius:999px;background:var(--a-accent-tint);color:var(--a-accent);margin-bottom:${gap(0.8)}}
${root} .a-sec{margin-top:${gap(2.2)}}
${root} .a-sec>h2{font-size:${size(2)};margin-bottom:${gap(0.9)}}
${root} .a-sec h3{font-size:${size(1)};margin:${gap(1.2)} 0 ${gap(0.5)}}
${root} .a-text p{max-width:68ch}
${root} sup.a-c{font-size:.68em;line-height:0;margin-left:1px;font-family:${fontStack("Inter")};font-variant-numeric:tabular-nums}
${root} sup.a-c a{padding:0 1px}
${root} .a-facts{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:${gap(0.6)};margin:0 0 ${gap(1)}}
${root} .a-fact{background:var(--a-surface);border-radius:var(--a-radius);padding:${gap(0.7)} ${gap(0.9)}}
${root} .a-fact dt{font-size:${size(-1)};color:var(--a-muted);margin-bottom:2px}
${root} .a-fact dd{margin:0;font-weight:600}
${root} .a-tl{list-style:none;margin:0 0 ${gap(1)};padding:0}
${root} .a-tl li{display:grid;grid-template-columns:8.5em 1fr;gap:${gap(0.8)};padding:${gap(0.45)} 0;border-top:1px solid var(--a-line)}
${root} .a-tl li:first-child{border-top:0}
${root} .a-when{color:var(--a-muted);font-variant-numeric:tabular-nums;font-size:${size(-1)};padding-top:2px}
${root} .a-tl .a-what{font-weight:600}
${root} .a-tl .a-detail{display:block;color:var(--a-muted);font-weight:400}
${root} .a-people{display:flex;flex-wrap:wrap;gap:${gap(0.5)};list-style:none;margin:0 0 ${gap(1)};padding:0}
${root} .a-person{display:flex;align-items:center;gap:.6em;background:var(--a-surface);border-radius:999px;padding:.3em .9em .3em .3em}
${root} .a-ini{display:inline-flex;align-items:center;justify-content:center;width:2em;height:2em;border-radius:999px;background:var(--a-accent2-tint);color:var(--a-accent2);font-weight:700;font-size:.8em;font-family:${display}}
${root} .a-role{color:var(--a-muted);font-size:${size(-1)}}
${root} table.a-table{width:100%;border-collapse:collapse;margin:0 0 ${gap(1)};font-size:${size(-0.5)}}
${root} .a-table th{text-align:left;font-weight:600;color:var(--a-muted);border-bottom:1px solid var(--a-ink);padding:${gap(0.4)} ${gap(0.5)} ${gap(0.4)} 0}
${root} .a-table td{border-bottom:1px solid var(--a-line);padding:${gap(0.45)} ${gap(0.5)} ${gap(0.45)} 0;vertical-align:top;font-variant-numeric:tabular-nums}
${root} blockquote.a-quote{margin:${gap(1)} 0;padding:0 0 0 ${gap(1)};border-left:3px solid var(--a-accent);font-family:${display};font-size:${size(1)};line-height:1.4}
${root} .a-quote footer{font-family:${body};font-size:${size(-1)};color:var(--a-muted);margin-top:${gap(0.4)}}
${root} figure.a-fig{margin:${gap(1)} 0}
${root} .a-fig img{display:block;max-width:100%;border-radius:var(--a-radius)}
${root} .a-fig figcaption{font-size:${size(-1)};color:var(--a-muted);margin-top:${gap(0.4)}}
${root} .a-sources{margin-top:${gap(3)};padding-top:${gap(1)};border-top:1px solid var(--a-line);font-size:${size(-1)}}
${root} .a-sources h2{font-size:${size(1)};margin-bottom:${gap(0.6)}}
${root} .a-sources ol{margin:0;padding-left:1.6em}
${root} .a-sources li{margin:0 0 ${gap(0.45)};padding-left:.2em}
${root} .a-sources q{display:block;color:var(--a-muted);font-style:italic}
${root} .a-sources :target{background:var(--a-accent-tint)}
${root} .a-foot{margin-top:${gap(2)};font-size:${size(-1)};color:var(--a-muted)}
${root} .a-muted{color:var(--a-muted)}
${kind === "one_pager" ? `${root} .a-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 ${gap(2.2)}}
${root} .a-grid .a-sec:first-child{grid-column:1/-1}
@media (max-width:640px){${root} .a-grid{grid-template-columns:1fr}}` : ""}
${kind === "profile" ? `${root} .a-prof{display:grid;grid-template-columns:minmax(0,1fr);gap:${gap(1)}}
${root} .a-avatar{width:${size(5)};height:${size(5)};border-radius:999px;background:var(--a-accent2-tint);color:var(--a-accent2);display:flex;align-items:center;justify-content:center;font-family:${display};font-weight:700;font-size:${size(3)};margin-bottom:${gap(1)}}
${root} .a-cover.band .a-avatar{background:var(--a-bg);}` : ""}
${deck ? deckCss(root, t, display, body, gap, mode) : ""}
${mode === "print" || mode === "standalone" ? printCss(root, kind) : ""}
@media (max-width:560px){${root} .a-page{padding:${gap(1.5)} 16px ${gap(2.5)}}${root} .a-tl li{grid-template-columns:1fr;gap:2px}}`;
  return css;
}

function deckCss(root: string, t: DesignTokens, display: string, body: string, gap: (n: number) => string, mode: string): string {
  return `${root}.a-deck{background:transparent}
${root} .a-slides{display:flex;flex-direction:column;gap:${mode === "print" ? "0" : "24px"};padding:${mode === "screen" ? "0" : "24px"};max-width:1200px;margin:0 auto}
${root} .a-slide{position:relative;aspect-ratio:16/9;width:100%;container-type:inline-size;background:var(--a-bg);color:var(--a-ink);border-radius:var(--a-radius);overflow:hidden;box-shadow:0 0 0 1px var(--a-line);display:flex;flex-direction:column;padding:5.5cqw 6cqw 4.5cqw}
${root} .a-slide h1{font-size:6.2cqw;line-height:1.05}
${root} .a-slide h2{font-size:3.6cqw;margin-bottom:2.2cqw}
${root} .a-slide h3{font-size:2.2cqw;margin:1.4cqw 0 .6cqw}
${root} .a-slide .a-body{flex:1;min-height:0;overflow:hidden;font-size:1.75cqw;line-height:1.45}
${root} .a-slide .a-sub{font-size:2.3cqw}
${root} .a-slide .a-by{font-size:1.5cqw}
${root} .a-slide .a-facts{grid-template-columns:repeat(auto-fill,minmax(20cqw,1fr));gap:1.2cqw}
${root} .a-slide .a-fact{padding:1.2cqw 1.5cqw}
${root} .a-slide .a-fact dt,${root} .a-slide .a-when,${root} .a-slide .a-role{font-size:1.35cqw}
${root} .a-slide .a-tl li{grid-template-columns:14cqw 1fr;padding:.7cqw 0}
${root} .a-slide table.a-table{font-size:1.5cqw}
${root} .a-slide blockquote.a-quote{font-size:2.6cqw}
${root} .a-slide .a-sources{margin:0;border:0;padding:0;font-size:1.3cqw}
${root} .a-slide .a-sources ol{columns:2;column-gap:3cqw}
${root} .a-slide.cover{justify-content:flex-end}
${root} .a-slide.cover.band{background:var(--a-accent);color:var(--a-on-accent)}
${root} .a-slide.cover.band h1,${root} .a-slide.cover.band .a-sub,${root} .a-slide.cover.band .a-by{color:var(--a-on-accent)}
${root} .a-slide.cover.rule h1{border-top:.9cqw solid var(--a-ink);padding-top:2cqw}
${root} .a-slide .a-logo{position:absolute;top:4.5cqw;left:6cqw;max-height:4cqw;margin:0}
${root} .a-slide .a-num{position:absolute;right:6cqw;bottom:2.4cqw;font-size:1.2cqw;color:var(--a-muted);font-variant-numeric:tabular-nums}
${root} .a-slide .a-sfoot{position:absolute;left:6cqw;bottom:2.4cqw;font-size:1.2cqw;color:var(--a-muted)}
${root}[data-present] .a-slides{gap:0;padding:0}
${root}[data-present] .a-slide:not([data-active]){display:none}
${root}[data-present] .a-slide{box-shadow:none}
${root} .a-slide p{max-width:none}
${root} .a-text p{max-width:none}
${root} .a-slide h1,${root} .a-slide h2{font-family:${display}}${root} .a-slide{font-family:${body}}`;
}

function printCss(root: string, kind: ArtifactKind): string {
  if (kind === "deck") {
    return `@media print{@page{size:297mm 167.06mm;margin:0}
html,body{margin:0;padding:0;background:var(--a-bg)}
${root} .a-slides{padding:0;gap:0;max-width:none}
${root} .a-slide{border-radius:0;box-shadow:none;break-after:page;page-break-after:always;width:297mm;height:167.06mm;aspect-ratio:auto;container-type:size}
${root} .a-slide:last-child{break-after:auto;page-break-after:auto}
${root}{-webkit-print-color-adjust:exact;print-color-adjust:exact}}`;
  }
  return `@media print{@page{size:A4;margin:16mm 16mm 18mm}
${root}{background:transparent;-webkit-print-color-adjust:exact;print-color-adjust:exact}
${root} .a-page{max-width:none;padding:0}
${root} .a-sec{break-inside:auto}
${root} .a-sec>h2,${root} h3{break-after:avoid}
${root} .a-fact,${root} .a-tl li,${root} tr,${root} blockquote,${root} figure{break-inside:avoid}
${root} a{color:var(--a-ink)}}`;
}

/* ── HTML ────────────────────────────────────────────────────────────────────────────────────────────── */

type Ctx = {
  nums: Map<string, number>;
  byId: Map<string, Citation>;
  sc: string;
  links: NonNullable<RenderInput["links"]>;
};

function citeMark(ctx: Ctx, cid: string): string {
  const n = ctx.nums.get(cid);
  if (!n) return "";
  const c = ctx.byId.get(cid);
  const title = c ? esc(c.label + (c.quote ? ` — “${c.quote.slice(0, 140)}”` : "")) : "";
  return `<sup class="a-c"><a href="#${ctx.sc}-s${n}" title="${title}">${n}</a></sup>`;
}

function citeMarks(ctx: Ctx, ids: string[]): string {
  return [...new Set(ids)].map((x) => citeMark(ctx, x)).join("");
}

/** Escaped inline text with citation markers and @mentions. */
function inline(ctx: Ctx, text: string): string {
  let out = "";
  let last = 0;
  const re = new RegExp(`${CITE_RE.source}|${MENTION.source}`, "g");
  for (const m of text.matchAll(re)) {
    out += esc(text.slice(last, m.index));
    if (m[1]) out += citeMark(ctx, m[1]);
    else if (m[2] && m[3]) {
      const href = safeHref(ctx.links.node?.(m[3]));
      out += href ? `<a href="${esc(href)}">${esc(m[2])}</a>` : esc(m[2]);
    }
    last = (m.index ?? 0) + m[0].length;
  }
  return out + esc(text.slice(last));
}

function paragraphs(ctx: Ctx, text: string): string {
  return text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean).map((p) => `<p>${inline(ctx, p).replace(/\n/g, "<br>")}</p>`).join("");
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() || "?";
}

function block(ctx: Ctx, b: Block): string {
  switch (b.type) {
    case "heading": return b.text.trim() ? `<h3>${esc(b.text)}</h3>` : "";
    case "text": return `<div class="a-text">${paragraphs(ctx, b.text)}</div>`;
    case "facts": return b.items.length ? `<dl class="a-facts">${b.items.map((i) => `<div class="a-fact"><dt>${esc(i.label)}</dt><dd>${inline(ctx, i.value)}${citeMarks(ctx, i.cites)}</dd></div>`).join("")}</dl>` : "";
    case "timeline": return b.items.length ? `<ol class="a-tl">${b.items.map((i) => `<li><span class="a-when">${esc(i.when)}</span><span><span class="a-what">${inline(ctx, i.label)}</span>${citeMarks(ctx, i.cites)}${i.detail ? `<span class="a-detail">${inline(ctx, i.detail)}</span>` : ""}</span></li>`).join("")}</ol>` : "";
    case "people": return b.items.length ? `<ul class="a-people">${b.items.map((i) => {
      const href = i.nodeId ? safeHref(ctx.links.node?.(i.nodeId)) : null;
      const name = href ? `<a href="${esc(href)}">${esc(i.name)}</a>` : esc(i.name);
      return `<li class="a-person"><span class="a-ini" aria-hidden="true">${esc(initials(i.name))}</span><span>${name}${citeMarks(ctx, i.cites)}${i.role ? `<br><span class="a-role">${esc(i.role)}</span>` : ""}</span></li>`;
    }).join("")}</ul>` : "";
    case "table": {
      const cols = b.columns.length;
      const head = b.columns.some((c) => c.trim()) ? `<thead><tr>${b.columns.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead>` : "";
      const rows = b.rows.map((r) => `<tr>${Array.from({ length: Math.max(cols, r.cells.length) }, (_, i) => `<td>${inline(ctx, r.cells[i] ?? "")}${i === Math.max(cols, r.cells.length) - 1 ? citeMarks(ctx, r.cites) : ""}</td>`).join("")}</tr>`).join("");
      return `<table class="a-table">${head}<tbody>${rows}</tbody></table>`;
    }
    case "quote": return b.text.trim() ? `<blockquote class="a-quote"><p>${inline(ctx, b.text)}${citeMarks(ctx, b.cites)}</p>${b.attribution ? `<footer>${esc(b.attribution)}</footer>` : ""}</blockquote>` : "";
    case "image": {
      if (/^0{8}-/.test(b.sourceId)) return "";
      const src = ctx.links.image?.(b.sourceId) ?? `/api/files/${b.sourceId}`;
      const s = safeHref(src) ?? (src.startsWith("data:image/") ? src : null);
      return s ? `<figure class="a-fig"><img src="${esc(s)}" alt="${esc(b.alt || b.caption)}" loading="lazy">${b.caption ? `<figcaption>${esc(b.caption)}</figcaption>` : ""}</figure>` : "";
    }
  }
}

function sectionHtml(ctx: Ctx, s: Section, tag: "h2" | "none" = "h2"): string {
  const head = tag === "h2" && s.title.trim() ? `<h2>${esc(s.title)}</h2>` : "";
  return `${head}${s.blocks.map((b) => block(ctx, b)).join("")}`;
}

function sourcesHtml(ctx: Ctx, content: ArtifactContent, labels: RenderLabels, heading = true): string {
  const list = usedCitations(content);
  if (!list.length) return "";
  const items = list.map((c) => {
    const href = safeHref(
      c.kind === "source" && c.sourceId ? ctx.links.source?.(c.sourceId)
      : c.nodeId ? ctx.links.node?.(c.nodeId)
      : c.sourceId ? ctx.links.source?.(c.sourceId) : null,
    );
    const label = href ? `<a href="${esc(href)}">${esc(c.label)}</a>` : esc(c.label);
    const loc = c.locator ? ` <span class="a-muted">${esc(c.locator)}</span>` : "";
    const q = c.quote ? `<q>${esc(c.quote)}</q>` : "";
    return `<li id="${ctx.sc}-s${c.n}" value="${c.n}">${label}${loc}${q}</li>`;
  }).join("");
  return `<section class="a-sources">${heading ? `<h2>${esc(labels.sources)}</h2>` : ""}<ol>${items}</ol></section>`;
}

function logoHtml(t: DesignTokens, tpl: KindTemplate): string {
  if (!tpl.showLogo || !t.logo) return "";
  const src = t.logo.src;
  const ok = src.startsWith("data:image/") || safeHref(src);
  return ok ? `<img class="a-logo" src="${esc(src)}" alt="${esc(t.logo.alt)}">` : "";
}

let scopeCounter = 0;

export function renderArtifact(input: RenderInput): Rendered {
  const labels = { ...DEFAULT_LABELS, ...(input.labels ?? {}) };
  const sc = `mga-${(input.scope ?? `r${++scopeCounter}`).replace(/[^A-Za-z0-9_-]/g, "")}`;
  const mode = input.mode ?? "screen";
  const theme = input.theme ?? "auto";
  const t = input.tokens;
  const tpl = input.template;
  const ctx: Ctx = {
    nums: citationNumbers(input.content),
    byId: new Map(input.content.citations.map((c) => [c.id, c])),
    sc,
    links: input.links ?? {},
  };
  const css = buildCss(sc, t, input.kind, theme, mode);
  const fontsHref = googleFontsHref([t.fonts.display, t.fonts.body]);
  const title = esc(input.title);
  const sub = input.content.subtitle ? `<p class="a-sub">${esc(input.content.subtitle)}</p>` : "";
  const by = input.byline ? `<div class="a-by">${esc(input.byline)}</div>` : "";
  const badge = input.status === "draft" ? `<span class="a-badge">${esc(labels.draft)}</span>` : "";
  const foot = tpl.footer ? `<div class="a-foot">${esc(tpl.footer)}</div>` : "";
  const logo = logoHtml(t, tpl);
  let html: string;

  if (input.kind === "deck") {
    const slides: string[] = [];
    const sections = input.content.sections;
    const hasSources = usedCitations(input.content).length > 0;
    const total = 1 + sections.length + (hasSources ? 1 : 0);
    const num = (n: number) => `<span class="a-num">${esc(interpolate(labels.slide, { n, total }))}</span>`;
    const sfoot = tpl.footer ? `<span class="a-sfoot">${esc(tpl.footer)}</span>` : "";
    slides.push(`<section class="a-slide cover ${tpl.cover}" data-slide="0">${logo}${badge ? `<div>${badge}</div>` : ""}<h1>${title}</h1>${sub}${by}${num(1)}</section>`);
    sections.forEach((s, i) => {
      slides.push(`<section class="a-slide" data-slide="${i + 1}">${s.title.trim() ? `<h2>${esc(s.title)}</h2>` : ""}<div class="a-body">${sectionHtml(ctx, s, "none")}</div>${sfoot}${num(i + 2)}</section>`);
    });
    if (hasSources) slides.push(`<section class="a-slide" data-slide="${total - 1}"><h2>${esc(labels.sources)}</h2><div class="a-body">${sourcesHtml(ctx, input.content, labels, false)}</div>${num(total)}</section>`);
    html = `<div class="${sc} a-deck" data-kind="deck"><div class="a-slides">${slides.join("")}</div></div>`;
  } else {
    const coverCls = `a-cover ${tpl.cover}`;
    const avatar = input.kind === "profile" ? `<div class="a-avatar" aria-hidden="true">${esc(initials(input.title))}</div>` : "";
    const cover = `<header class="${coverCls}">${logo}${badge ? `<div>${badge}</div>` : ""}${avatar}<h1>${title}</h1>${sub}${by}</header>`;
    const secs = input.content.sections.map((s) => `<section class="a-sec" id="${sc}-${esc(s.id)}">${sectionHtml(ctx, s)}</section>`).join("");
    const bodyCls = input.kind === "one_pager" ? "a-grid" : input.kind === "profile" ? "a-prof" : "a-flow";
    html = `<div class="${sc}" data-kind="${input.kind}"><article class="a-page">${cover}<div class="${bodyCls}">${secs}</div>${sourcesHtml(ctx, input.content, labels)}${foot}</article></div>`;
  }
  return { css, html, fontsHref, className: sc };
}

/** Keyboard paging for a downloaded deck: arrows, space and PageUp/PageDown move between slides. */
const DECK_SCRIPT = `(function(){var s=[].slice.call(document.querySelectorAll('.a-slide'));function cur(){var y=window.scrollY+window.innerHeight/3,i=0;s.forEach(function(e,k){if(e.offsetTop<=y)i=k});return i}document.addEventListener('keydown',function(e){var k=e.key,d=0;if(k==='ArrowRight'||k==='ArrowDown'||k==='PageDown'||k===' ')d=1;if(k==='ArrowLeft'||k==='ArrowUp'||k==='PageUp')d=-1;if(!d)return;e.preventDefault();var i=Math.max(0,Math.min(s.length-1,cur()+d));s[i].scrollIntoView({behavior:'smooth',block:'center'})})})();`;

/** A complete, self-contained HTML document (the "Download HTML" file). */
export function renderStandalone(input: RenderInput & { lang?: string; description?: string }): string {
  const r = renderArtifact({ ...input, mode: "standalone" });
  const deck = input.kind === "deck";
  return `<!doctype html>
<html lang="${esc(input.lang ?? "en")}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(input.title)}</title>
${input.description ? `<meta name="description" content="${esc(input.description)}">` : ""}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${esc(r.fontsHref)}">
<style>html,body{margin:0;padding:0}body{background:${deck ? "var(--a-surface,#eee)" : "inherit"}}
${r.css}
body:has(.${r.className}){background:${input.theme === "dark" ? input.tokens.colors.dark.bg : input.tokens.colors.light.bg}}
@media (prefers-color-scheme: dark){body:has(.${r.className}){background:${input.tokens.colors.dark.bg}}}</style>
</head>
<body>
${r.html}
${deck ? `<script>${DECK_SCRIPT}</script>` : ""}
</body>
</html>`;
}
