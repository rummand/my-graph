/**
 * "From a website" (pure): read a page's HTML (and a little of its CSS) as data and propose colours, fonts and a
 * logo for a design set. Nothing on the page is followed as an instruction; we only count colours and font names.
 */
import {
  deriveDark, contrast, luminance, mix, nearestFont, normalizeHex, startingTokens, type DesignTokens, type Palette,
} from "./tokens";

export type SiteProposal = {
  name: string;
  tokens: DesignTokens;
  /** Where each guess came from, in plain words, for the person to check. */
  notes: string[];
  /** Absolute URL of the logo candidate (fetched separately and turned into a data URI). */
  logoUrl: string | null;
  /** Visible text for the tone-of-voice guess. */
  sampleText: string;
};

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return m ? (m[2] ?? m[3] ?? m[4] ?? "") : null;
}

function decode(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ");
}

function absolute(href: string, base: string): string | null {
  try {
    const u = new URL(decode(href), base);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/** Stylesheet URLs linked from the page (first few, same order). */
export function stylesheetLinks(html: string, base: string, max = 3): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/rel\s*=\s*["']?[^"'>]*stylesheet/i.test(tag)) continue;
    const href = attr(tag, "href");
    if (!href || /fonts\.googleapis\.com/i.test(href)) continue;
    const abs = absolute(href, base);
    if (abs) out.push(abs);
    if (out.length >= max) break;
  }
  return out;
}

/** Google Fonts families named in the page's links (`family=Inter:wght@…`). */
export function googleFamilies(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/fonts\.googleapis\.com\/css2?\?[^"'\s>]+/gi)) {
    for (const f of decode(m[0]).matchAll(/family=([^:&]+)/g)) out.push(decodeURIComponent(f[1].replace(/\+/g, " ")));
  }
  return [...new Set(out)];
}

type Weighted = Map<string, number>;
function bump(m: Weighted, k: string, w = 1) {
  m.set(k, (m.get(k) ?? 0) + w);
}

function saturation(hex: string): number {
  const n = normalizeHex(hex)!;
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(n.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  if (max === min) return 0;
  const l = (max + min) / 2;
  return l > 0.5 ? (max - min) / (2 - max - min) : (max - min) / (max + min);
}

/** Colours used in the page and its CSS, weighted (custom properties and theme-color count most). */
export function colorsIn(html: string, css: string): { all: Weighted; themeColor: string | null; vars: Record<string, string> } {
  const all: Weighted = new Map();
  const vars: Record<string, string> = {};
  const text = `${html}\n${css}`;
  for (const m of text.matchAll(/--([\w-]{1,40})\s*:\s*(#[0-9a-f]{3,8}\b|rgba?\([^)]{5,40}\))/gi)) {
    const hex = normalizeHex(m[2]);
    if (!hex) continue;
    vars[m[1].toLowerCase()] = hex;
    bump(all, hex, 3);
  }
  for (const m of text.matchAll(/(?:color|background(?:-color)?|fill|border(?:-color)?)\s*:\s*(#[0-9a-f]{3,8}\b|rgba?\([^)]{5,40}\))/gi)) {
    const hex = normalizeHex(m[1]);
    if (hex) bump(all, hex, 1);
  }
  let themeColor: string | null = null;
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    if (/name\s*=\s*["']?theme-color/i.test(m[0])) {
      themeColor = normalizeHex(attr(m[0], "content") ?? "");
      if (themeColor) bump(all, themeColor, 6);
      break;
    }
  }
  return { all, themeColor, vars };
}

function pickVar(vars: Record<string, string>, ...patterns: RegExp[]): string | null {
  for (const p of patterns) for (const [k, v] of Object.entries(vars)) if (p.test(k)) return v;
  return null;
}

/** Font families declared in CSS, most used first. */
export function fontsIn(css: string): string[] {
  const m: Weighted = new Map();
  for (const x of css.matchAll(/font-family\s*:\s*([^;}{]{1,200})/gi)) {
    const v = x[1].trim();
    if (/var\(/.test(v) || /inherit|initial/.test(v)) continue;
    bump(m, v);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
}

/** The best logo candidate: an <img> whose class/alt/src says logo, else apple-touch-icon, else an SVG/PNG icon. */
export function logoCandidate(html: string, base: string): string | null {
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const hay = `${attr(tag, "class") ?? ""} ${attr(tag, "alt") ?? ""} ${attr(tag, "src") ?? ""} ${attr(tag, "id") ?? ""}`;
    if (/logo|brand/i.test(hay)) {
      const src = attr(tag, "src");
      const abs = src ? absolute(src, base) : null;
      if (abs) return abs;
    }
  }
  const icons: { href: string; score: number }[] = [];
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const rel = (attr(m[0], "rel") ?? "").toLowerCase();
    const href = attr(m[0], "href");
    if (!href) continue;
    if (rel.includes("apple-touch-icon")) icons.push({ href, score: 3 });
    else if (rel.includes("icon")) icons.push({ href, score: /\.svg/i.test(href) ? 2 : 1 });
  }
  icons.sort((a, b) => b.score - a.score);
  return icons[0] ? absolute(icons[0].href, base) : null;
}

export function pageTitle(html: string): string {
  const og = /<meta\b[^>]*property\s*=\s*["']og:site_name["'][^>]*>/i.exec(html);
  const site = og ? attr(og[0], "content") : null;
  if (site) return decode(site).trim().slice(0, 60);
  const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return t ? decode(t[1]).split(/[|–—·-]/)[0].trim().slice(0, 60) : "";
}

/** Visible text (scripts, styles and tags stripped), for the tone guess. */
export function visibleText(html: string, max = 3000): string {
  return decode(html.replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ").trim().slice(0, max);
}

/** Propose a design set from a page's HTML and CSS. */
export function proposeFromSite(input: { url: string; html: string; css?: string }): SiteProposal {
  const { url, html } = input;
  const css = `${input.css ?? ""}\n${[...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join("\n")}\n${[...html.matchAll(/\bstyle\s*=\s*"([^"]*)"/gi)].map((m) => m[1]).join(";")}`;
  const notes: string[] = [];
  const base = startingTokens("minimal").tokens;
  const { all, themeColor, vars } = colorsIn(html, css);
  const ranked = [...all.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);

  const lights = ranked.filter((c) => luminance(c) > 0.85);
  const darks = ranked.filter((c) => luminance(c) < 0.06);
  const chromatic = ranked.filter((c) => saturation(c) > 0.35 && luminance(c) > 0.03 && luminance(c) < 0.75);

  // A light page unless the site clearly says otherwise: exact variable names first, then the most used light colour.
  const bg = pickVar(vars, /^(bg|background|color-bg|color-background|body-bg|page-bg)$/) ?? lights[0] ?? "#ffffff";
  const bgDark = luminance(bg) < 0.2;
  const ink = pickVar(vars, /^(fg|text|ink|color-text|body-color|foreground|color-foreground)$/)
    ?? (bgDark ? lights[0] : darks[0]) ?? (bgDark ? "#f5f5f5" : "#151515");
  let accent = pickVar(vars, /^(primary|accent|brand|color-primary|link)$/, /primary|accent|brand/) ?? themeColor ?? chromatic[0] ?? "#2f4bb0";
  if (luminance(accent) > 0.8) accent = chromatic[0] ?? "#2f4bb0";
  const accent2 = chromatic.find((c) => c !== accent && Math.abs(luminance(c) - luminance(accent)) > 0.02) ?? mix(accent, ink, 0.4);
  const surface = bgDark ? mix(bg, "#ffffff", 0.06) : (lights.find((c) => c !== bg && luminance(c) < luminance(bg)) ?? mix(bg, ink, 0.035));
  const muted = ranked.find((c) => { const l = luminance(c); return l > 0.12 && l < 0.4 && saturation(c) < 0.25; }) ?? mix(ink, bg, 0.42);
  const light: Palette = { bg, surface, ink, muted, accent, accent2, line: bg };
  // Keep text readable whatever the page used.
  if (contrast(light.ink, light.bg) < 4.5) light.ink = luminance(light.bg) > 0.4 ? "#151515" : "#f5f5f5";
  if (contrast(light.ink, light.surface) < 4.5) light.surface = mix(light.bg, light.ink, 0.04);
  if (contrast(light.muted, light.bg) < 3) light.muted = mix(light.ink, light.bg, 0.4);
  light.line = mix(light.bg, light.ink, 0.12);
  notes.push(themeColor ? `Accent from the site's theme colour ${themeColor}.` : `Accent ${accent} is the most used strong colour on the page.`);
  if (Object.keys(vars).length) notes.push(`Read ${Object.keys(vars).length} colour variables from the site's CSS.`);
  notes.push("Dark colours are derived from the light ones; check them in the preview.");

  const gf = googleFamilies(html);
  const cssFonts = fontsIn(css);
  const headingCss = /h1[^{]{0,80}\{[^}]*font-family\s*:\s*([^;}]+)/i.exec(css)?.[1];
  const body = (gf[0] && nearestFont(gf[0])) || (cssFonts[0] && nearestFont(cssFonts[0])) || base.fonts.body;
  const display = (headingCss && nearestFont(headingCss)) || (gf[1] && nearestFont(gf[1])) || body;
  const named = [...gf, ...cssFonts.slice(0, 2)].join(", ");
  notes.push(named ? `Fonts: the site uses ${named.slice(0, 120)}; closest in our list: ${display} and ${body}.` : `No fonts found; using ${body}.`);

  const logoUrl = logoCandidate(html, url);
  if (logoUrl) notes.push("Found a logo on the page.");

  const tokens: DesignTokens = {
    ...base,
    colors: { light, dark: deriveDark(light) },
    fonts: { display, body },
    radius: /border-radius\s*:\s*(0|0px)\b/i.test(css) && !/border-radius\s*:\s*[1-9]/i.test(css) ? 0 : 6,
    tone: "",
  };
  return { name: pageTitle(html) || new URL(url).hostname.replace(/^www\./, ""), tokens, notes, logoUrl, sampleText: visibleText(html) };
}
