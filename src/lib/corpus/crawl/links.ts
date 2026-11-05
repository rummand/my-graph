/**
 * Which links of a page the crawler follows (pure, unit-tested). Only what belongs to the rules: the same document's
 * parts (chapters, sections, the next page), a single full-text/print view (preferred: then the parts are skipped),
 * the document's PDFs, and one level out the guidance, annexes and executive orders it points to. Same site or an
 * official source only; never log-in, search, sharing, cookie or newsletter pages, pictures, scripts or feeds.
 */
import type { SourceRole } from "../pure";
import { OFFICIAL_HOST, hostOf } from "./classify";
import type { PageLink } from "./html";

export type Limits = { maxPages: number; maxDepth: number; maxPdfs: number; maxLinked: number };
export const DEFAULT_LIMITS: Limits = { maxPages: 60, maxDepth: 2, maxPdfs: 15, maxLinked: 8 };

export type LinkKind = "full" | "part" | "pdf" | "linked";
export type Candidate = { url: string; text: string; kind: LinkKind; role: SourceRole; reason: string; score: number };

const TRACKING = /^(utm_[a-z]+|fbclid|gclid|mc_[a-z]+|_ga|ref|source)$/i;

/** A URL without its fragment and tracking parameters, so the same page is fetched once. */
export function normalizeUrl(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  u.hash = "";
  for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
  u.hostname = u.hostname.toLowerCase();
  if ((u.protocol === "https:" && u.port === "443") || (u.protocol === "http:" && u.port === "80")) u.port = "";
  return u.toString();
}

const SKIP_PATH = /\/(login|log-?ind|signin|sign-in|logout|log-?ud|register|search|soeg|søg|sog|cookie\w*|privacy-settings|share|del|newsletter|nyhedsbrev|kontakt|contact|feed|rss|tag|tags|category|kategori|wp-admin|wp-login|cart|kurv|account|konto|profile)(\/|$|\?)/i;
const SKIP_FILE = /\.(jpe?g|png|gif|svg|webp|ico|css|js|mjs|json|zip|rar|7z|mp4|mp3|m4a|wav|mov|avi|ics|rss|atom|woff2?|ttf|eot|exe|dmg|apk)$/i;
const SOCIAL = /(^|\.)(facebook|twitter|x|linkedin|instagram|youtube|tiktok|pinterest|reddit|t|wa|whatsapp)\.(com|me|co)$/i;

const FULL = /\b(print\w*|udskriv\w*|printvenlig|hele (loven|teksten|dokumentet|vejledningen|bekendtgørelsen)|full text|whole (document|text)|single page|one page|vis (hele|alt)|samlet (tekst|version)|all chapters|alle kapitler)\b/i;
const PART = /\b(kapitel|kap\.|chapter|afsnit|section|del|part|bilag|annex|appendix|artikel|article|§|side|page|næste|next|fortsæt|continue|indhold|contents)\b|^\s*(\d+(\.\d+)*|[IVXLC]+)[.)]?\s+\S/i;
const LINKED = /\b(vejledning\w*|guidance|guideline\w*|bekendtgørelse\w*|executive order|cirkulære\w*|bilag|annex|appendix|retningslinje\w*|faq|spørgsmål og svar|fortolkning\w*|interpretation|regulativ\w*|standard\w*|skabelon\w*|template\w*|policy|politik)\b/i;
const INTERPRETS = /\b(vejledning\w*|guidance|guideline\w*|faq|spørgsmål og svar|fortolkning\w*|interpretation|retningslinje\w*|cirkulære\w*)\b/i;

export const isPdfUrl = (url: string, type?: string | null) => /\.pdf($|\?)/i.test(url) || /application\/pdf/i.test(type ?? "") || /\/pdf\/?$/i.test(new URL(url).pathname);

/** The folder of a page: "/love/barnets-lov/kapitel-1" → "/love/barnets-lov/". Parts of the same document live under it. */
export function folderOf(url: string): string {
  try {
    const p = new URL(url).pathname;
    return p.endsWith("/") ? p : p.slice(0, p.lastIndexOf("/") + 1);
  } catch { return "/"; }
}

/** May the crawler go to this host from the start page's host? The same site, or an official source. */
export function allowedHost(url: string, startUrl: string): boolean {
  const h = hostOf(url), s = hostOf(startUrl);
  if (!h) return false;
  if (h === s || h.endsWith(`.${s}`) || s.endsWith(`.${h}`)) return true;
  return OFFICIAL_HOST.test(h);
}

/**
 * The links of one page worth following, best first, with why. `depth` is the page's own depth (the start page is 0):
 * parts and the full view are followed from depth 0 and 1, linked guidance only from the start (one level out),
 * PDFs from any page within the depth limit.
 */
export function selectLinks(page: { url: string; depth: number }, links: PageLink[], ctx: { startUrl: string; visited: Set<string>; limits: Limits }): Candidate[] {
  if (page.depth >= ctx.limits.maxDepth) return [];
  const startFolder = folderOf(ctx.startUrl);
  const startHost = hostOf(ctx.startUrl);
  const out = new Map<string, Candidate>();
  for (const l of links) {
    const url = normalizeUrl(l.url);
    if (!url || ctx.visited.has(url) || url === normalizeUrl(page.url)) continue;
    let u: URL;
    try { u = new URL(url); } catch { continue; }
    const host = hostOf(url);
    if (SOCIAL.test(host) || !allowedHost(url, ctx.startUrl)) continue;
    const path = decodeURIComponent(u.pathname);
    if (SKIP_FILE.test(path) || SKIP_PATH.test(path) || path === "/" || /^\/(da|en|de)\/?$/i.test(path)) continue;
    const text = l.text ?? "";
    const words = `${text} ${path.replace(/[-_/]+/g, " ")}`;
    const sameSite = host === startHost;
    const underStart = sameSite && path.startsWith(startFolder) && startFolder.length > 1;
    let c: Candidate | null = null;
    if (isPdfUrl(url, l.type)) {
      const ofThis = page.depth === 0 && (/\b(pdf|print|download|hent|udskriv)\b/i.test(text) || underStart);
      c = { url, text, kind: "pdf", role: ofThis ? "text" : INTERPRETS.test(words) ? "interpretation" : "supporting", reason: ofThis ? "The document as a PDF" : "A PDF it links to", score: ofThis ? 90 : 50 };
    } else if (sameSite && FULL.test(text) && (underStart || page.depth === 0)) {
      c = { url, text, kind: "full", role: "text", reason: "The whole text on one page", score: 100 };
    } else if (underStart && PART.test(text || path)) {
      c = { url, text, kind: "part", role: "text", reason: "A part of the same document", score: 70 - page.depth * 10 };
    } else if (page.depth === 0 && LINKED.test(words)) {
      c = { url, text, kind: "linked", role: INTERPRETS.test(words) ? "interpretation" : "supporting", reason: INTERPRETS.test(words) ? "Guidance it points to" : "A related document it points to", score: sameSite ? 40 : 35 };
    }
    if (c && (!out.has(url) || out.get(url)!.score < c.score)) out.set(url, c);
  }
  return [...out.values()].sort((a, b) => b.score - a.score);
}
