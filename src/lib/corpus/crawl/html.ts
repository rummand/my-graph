/**
 * Pages into text (pure, unit-tested): an HTML page or EU XHTML as plain text with one block per paragraph (table rows
 * on one line, so "(a) the controller …" stays together), its title, and its links. No DOM: a forgiving tag scanner,
 * enough for law texts and guidance pages. What comes out is data, never instructions.
 */
import { decodeEntities } from "@/lib/ingest/formats/xml";

const NAMED: Record<string, string> = {
  nbsp: " ", shy: "", ndash: "–", mdash: "—", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", laquo: "«", raquo: "»", sect: "§", para: "¶",
  hellip: "…", euro: "€", bull: "•", middot: "·", deg: "°", times: "×", aelig: "æ", AElig: "Æ", oslash: "ø", Oslash: "Ø", aring: "å", Aring: "Å",
  auml: "ä", Auml: "Ä", ouml: "ö", Ouml: "Ö", uuml: "ü", Uuml: "Ü", eacute: "é", Eacute: "É", egrave: "è", agrave: "à", aacute: "á", oacute: "ó",
  iacute: "í", uacute: "ú", ccedil: "ç", ntilde: "ñ", szlig: "ß", copy: "©", reg: "®", trade: "™", frac12: "½", thinsp: " ", ensp: " ", emsp: " ", zwnj: "", zwj: "",
};

/** HTML entities (named, decimal and hex) into characters; soft hyphens go (the model never quotes them). */
export function decodeHtml(s: string): string {
  return decodeEntities(s.replace(/&([a-z]+[0-9]*);/gi, (m, n: string) => (n in NAMED ? NAMED[n] : m))).replace(/­/g, "");
}

/** Whitespace inside a line folded to single spaces (non-breaking and thin spaces too). */
export const squash = (s: string) => s.replace(/[\s  -​ ]+/g, " ").trim();

const DROP = /<(script|style|noscript|svg|template|head|iframe|object|canvas|select|button|form)\b[\s\S]*?<\/\1\s*>/gi;
const CHROME = /<(nav|header|footer|aside)\b[\s\S]*?<\/\1\s*>/gi;
const BLOCK_END = /<\/(p|div|li|h[1-6]|tr|section|article|table|blockquote|dt|dd|ul|ol|pre|main|figure|figcaption|caption|address)\s*>/gi;
const BLOCK_START = /<(p|div|li|h[1-6]|tr|section|article|table|blockquote|dt|dd|ul|ol|pre|main|figure|caption|address)\b[^>]*>/gi;

/**
 * The text of a page, one block per line pair. `keepChrome` keeps nav/header/footer (EU XHTML has none, and some
 * guidance sites wrap everything in <header>); by default site chrome is dropped.
 */
export function htmlToText(html: string, opts: { keepChrome?: boolean } = {}): string {
  let h = html.replace(/<!--[\s\S]*?-->/g, " ").replace(DROP, " ");
  if (!opts.keepChrome) h = h.replace(CHROME, " ");
  // A table row is one line: "(a) the controller …" (EU texts set points as tables of label and text).
  h = h.replace(/<tr\b[\s\S]*?<\/tr\s*>/gi, (row) => row.replace(/<\/?(p|div|span|br)\b[^>]*>/gi, " ").replace(/\s+/g, " "));
  h = h.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(td|th)\s*>/gi, " ").replace(BLOCK_END, "\n\n").replace(BLOCK_START, "\n\n").replace(/<[^>]+>/g, "");
  const text = decodeHtml(h);
  const blocks = text.split(/\n\s*\n/).map((b) => b.split("\n").map(squash).filter(Boolean).join(" ")).filter(Boolean);
  return blocks.join("\n\n");
}

/** The page's title: og:title when the <title> is only the site's name, else <title>. */
export function htmlTitle(html: string): string {
  const title = squash(decodeHtml(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? ""));
  const og = squash(decodeHtml(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']*)["']/i.exec(html)?.[1]
    ?? /<meta[^>]+content=["']([^"']*)["'][^>]*property=["']og:title["']/i.exec(html)?.[1] ?? ""));
  if (og && (!title || title.length < 20 || og.toLowerCase().includes(title.toLowerCase()))) return og;
  return title || og;
}

/** A meta tag's content (name= or property=). */
export function htmlMeta(html: string, name: string): string | null {
  const re = new RegExp(`<meta[^>]+(?:name|property)=["']${name.replace(/[.:]/g, "\\$&")}["'][^>]*content=["']([^"']*)["']`, "i");
  const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:name|property)=["']${name.replace(/[.:]/g, "\\$&")}["']`, "i");
  const m = re.exec(html) ?? re2.exec(html);
  return m ? squash(decodeHtml(m[1])) || null : null;
}

export type PageLink = { url: string; text: string; type?: string | null };

/** Every link of a page, resolved against the page (and its <base href>), without fragments, deduplicated. */
export function extractLinks(html: string, pageUrl: string): PageLink[] {
  let base = pageUrl;
  const b = /<base[^>]+href=["']([^"']+)["']/i.exec(html)?.[1];
  if (b) { try { base = new URL(b, pageUrl).toString(); } catch { /* keep the page */ } }
  const out = new Map<string, PageLink>();
  const add = (href: string, text: string, type: string | null) => {
    const raw = decodeHtml(href).trim();
    if (!raw || /^(mailto:|tel:|javascript:|data:|#)/i.test(raw)) return;
    let u: URL;
    try { u = new URL(raw, base); } catch { return; }
    if (u.protocol !== "http:" && u.protocol !== "https:") return;
    u.hash = "";
    const url = u.toString();
    const prev = out.get(url);
    const t = squash(decodeHtml(text.replace(/<[^>]+>/g, " "))).slice(0, 200);
    if (!prev || (!prev.text && t)) out.set(url, { url, text: t || prev?.text || "", type: type ?? prev?.type ?? null });
  };
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
    const href = /\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(m[1]);
    if (!href) continue;
    const title = /\btitle\s*=\s*("([^"]*)"|'([^']*)')/i.exec(m[1]);
    const type = /\btype\s*=\s*["']([^"']+)["']/i.exec(m[1])?.[1] ?? null;
    add(href[2] ?? href[3] ?? href[4] ?? "", m[2].trim() ? m[2] : (title?.[2] ?? title?.[3] ?? ""), type);
  }
  for (const m of html.matchAll(/<link\b([^>]*)>/gi)) {
    if (!/rel\s*=\s*["'](alternate)["']/i.test(m[1]) || !/application\/pdf/i.test(m[1])) continue;
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(m[1]);
    if (href) add(href[1], "PDF", "application/pdf");
  }
  return [...out.values()];
}
