/**
 * Web research, the pure parts (unit-tested, no DB, no network):
 *   needsWeb        does this question need the outside world?
 *   minimiseQuery   what may leave the graph in a search query (names and the topic; never health, CPR or notes)
 *   checkUrl        SSRF guard for a URL we are about to read (public web only; localhost only in development)
 *   chunkPage       a page's text as passages with character locators
 *   pickPassages    the passages of a page that answer the question best
 *   webSourceValues the `sources` row for a page read (kind "web", url, title, fetchedAt, text, query in meta)
 *   webFactsToChanges facts a model read on pages → change-set ops with receipts {url, sourceId, quote, confidence}
 */
import type { ChangeInput } from "@/lib/changes";

/* ── Does the question need the web? ──────────────────────────────────────────────────────────────────────── */

const URL_RE = /\bhttps?:\/\/[^\s<>"'()[\]{}]+[^\s<>"'()[\]{}.,;:!?]/gi;

/** URLs written in a text, in order, without duplicates. */
export function extractUrls(text: string): string[] {
  return [...new Set((text.match(URL_RE) ?? []).map((u) => u.trim()))].slice(0, 5);
}

const EXPLICIT = [
  /\b(look (it |this |that |him |her |them |these |those )?up|search (the web|online|the internet|google|for)|google|web ?search|on the (web|internet|net)|online|their website|the website|homepage|browse)\b/i,
  /\b(sl[åa] (det |dem |ham |hende )?op|s[øo]g (p[åa] nettet|efter|online)|p[åa] nettet|p[åa] internettet|online|hjemmesiden?|google)\b/i,
];
const CURRENT = [
  /\b(latest|newest|recent news|news about|currently|right now|this week's|today's|current (price|ceo|address|opening hours|version)|opening hours|price of|how much does .{1,40} cost|reviews? of|who (runs|owns|founded)|ceo of|founded)\b/i,
  /(?<![\p{L}\p{N}])(seneste|nyheder om|lige nu|aktuel\p{L}*|[åa]bningstid\p{L}*|hvad koster|anmeldelser? af|hvem ejer|direkt[øo]r for|grundlagt)(?![\p{L}\p{N}])/iu,
];
const PUBLIC_THING = [
  /\b(company|firm|business|organi[sz]ation|product|brand|app|school|kindergarten|club|restaurant|museum|municipality|author|politician|actor|band|book|film|movie)\b/i,
  /\b(firma\w*|virksomhed\w*|organisation\w*|produkt\w*|m[æa]rke|skole\w*|b[øo]rnehave\w*|klub\w*|forening\w*|restaurant\w*|museum|kommune\w*|forfatter\w*|politiker\w*|skuespiller\w*|bog|bogen|film\w*)\b/i,
];
/** Searching the family's own things is not a web search. */
const INSIDE = /\b(search|look|find|check|s[øo]g|find|kig|tjek)\w*\s+(in |through |i )?(my |our |the |mine |vores |min |mit )?(library|graph|notes|mail|inbox|wiki|pages|timeline|memory|biblioteket?|grafen|noter(ne)?|mail(en)?|indbakke(n)?|wiki(en)?|sider(ne)?|tidslinjen?|hukommelse(n)?)\b/i;
const WHO_WHAT = /^(who|what) (is|are|was|were)\b|^(hvem|hvad) (er|var)\b|^tell me about\b|^fort[æa]l (mig )?om\b/i;

export type WebNeed = { use: boolean; why: "url" | "asked" | "current" | "public" | "unknown_to_graph" | "no"; urls: string[] };

/**
 * The web is used when the question needs the outside world: it carries a URL, asks to look something up or search,
 * asks for current facts (news, prices, opening hours), or asks about a public company/product/person the graph
 * doesn't know. `graphHits`: how many items the family's own search found (0 = the graph knows nothing about it).
 */
export function needsWeb(question: string, opts: { graphHits?: number } = {}): WebNeed {
  const q = question.replace(/@\[([^\]]+)\]\(node:[0-9a-f-]{36}\)/gi, "$1").trim();
  const urls = extractUrls(q);
  if (urls.length) return { use: true, why: "url", urls };
  if (INSIDE.test(q) && !/\b(web|internet|online|nettet)\b/i.test(q)) return { use: false, why: "no", urls };
  if (EXPLICIT.some((r) => r.test(q))) return { use: true, why: "asked", urls };
  if (CURRENT.some((r) => r.test(q))) return { use: true, why: "current", urls };
  if (PUBLIC_THING.some((r) => r.test(q)) && WHO_WHAT.test(q) && (opts.graphHits ?? 0) === 0) return { use: true, why: "public", urls };
  if (WHO_WHAT.test(q) && (opts.graphHits ?? 1) === 0 && /\p{Lu}\p{Ll}+/u.test(q.replace(/^\S+/, ""))) return { use: true, why: "unknown_to_graph", urls };
  return { use: false, why: "no", urls };
}

/* ── What may leave the graph ─────────────────────────────────────────────────────────────────────────────── */

/** Health, money and other private matters: never sent to a search engine. English and Danish. */
const PRIVATE_WORDS = /\b(diagnos\w*|sygdom\w*|syg|sick|ill(ness)?|disease|disorder|adhd|autis\w*|asperger\w*|depress\w*|angst|anxiety|cancer|kr[æa]ft|diabet\w*|epilep\w*|allerg\w*|medicin\w*|medication|medicine|pills?|piller|therap\w*|terapi\w*|psykolog\w*|psychiatr\w*|psykiat\w*|pregnan\w*|gravid\w*|abort\w*|vaccin\w*|journal|patient\w*|hospital\w*|hospitals?|sygehus\w*|læge\w*|doctor'?s?|blood|blod\w*|symptom\w*|treatment|behandling\w*|weight|v[æa]gt|cpr(-?nummer)?|personnummer|social security|passport|pasnummer|salary|l[øo]n(nen)?|debt|g[æa]ld|bank ?account|kontonummer|password|adgangskode|pin(kode)?|divorce|skilsmisse|custody|for[æa]ldremyndighed|police|politi(et)?|trivsel|wellbeing|well-being|mobbe?\w*|bully\w*|bullied)\b/gi;

/** Request phrasing that says nothing about the topic. */
const FILLER = /\b(can you|could you|would you|please|for me|look (it |this |that )?up|search (the web |online |the internet )?(for)?|google|on the (web|internet|net)|online|tell me|find out|i want to know|i wonder|kan du|vil du|venligst|for mig|sl[åa] (det )?op|s[øo]g (p[åa] nettet )?(efter)?|p[åa] (nettet|internettet)|fort[æa]l (mig)?|find ud af|jeg vil gerne vide)\b/gi;

const CPR = /\b\d{6}[- ]?\d{4}\b/g;
const EMAIL = /\b[\w.+-]+@[\w-]+(\.[\w-]+)+\b/g;
const PHONE = /(\+\d{1,3}[\s-]?)?\b(\d[\s-]?){8,}\b/g;
const LONG_NUMBER = /\b\d{7,}\b/g;

export type MinimisedQuery = { query: string; dropped: string[] };

/**
 * A search query from a question, keeping only what a search engine needs: the names and the topic. Mentions become
 * their labels; URLs, CPR numbers, e-mail addresses, phone numbers, health and other private words are taken out,
 * and so is anything in `avoid` (labels of sensitive items, private notes). At most 12 words.
 */
export function minimiseQuery(question: string, opts: { avoid?: string[] } = {}): MinimisedQuery {
  const dropped: string[] = [];
  const take = (re: RegExp, what: string) => (s: string) => s.replace(re, (m) => { dropped.push(what === "word" ? m.toLowerCase() : what); return " "; });
  let q = question.replace(/@\[([^\]]+)\]\(node:[0-9a-f-]{36}\)/gi, "$1");
  q = take(URL_RE, "url")(q);
  q = take(CPR, "cpr")(q);
  q = take(EMAIL, "email")(q);
  q = take(PHONE, "phone")(q);
  q = take(LONG_NUMBER, "number")(q);
  for (const a of opts.avoid ?? []) {
    const t = a.trim();
    if (t.length < 3) continue;
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(t)}(?=$|[^\\p{L}\\p{N}])`, "giu");
    q = q.replace(re, (_m, pre: string) => { dropped.push("private"); return `${pre} `; });
  }
  q = take(PRIVATE_WORDS, "word")(q);
  q = q.replace(FILLER, " ");
  const words = q.replace(/[?!¿¡"“”„«»]/g, " ").replace(/\s+([,.;:])/g, "$1").replace(/[,.;:]+(\s|$)/g, " ").split(/\s+/).filter(Boolean);
  // Leading request words left over ("the", "about", "om") say nothing on their own.
  while (words.length && /^(the|about|a|an|of|on|om|den|det|de|en|et|and|og|me|mig|what|hvad|is|er)$/i.test(words[0]) && words.length > 2) words.shift();
  // A name said twice ("Zoo … Copenhagen Zoo") is searched once, where it stands last.
  const deduped = words.filter((w, i) => w.length < 3 || !words.slice(i + 1).some((x) => x.toLowerCase() === w.toLowerCase()));
  const query = deduped.slice(0, 12).join(" ").slice(0, 150).trim();
  return { query: meaningful(query) ? query : "", dropped: [...new Set(dropped)] };
}

const STOP = new Set(["the", "a", "an", "of", "on", "in", "is", "are", "what", "who", "when", "where", "how", "about", "and", "or", "to", "for", "with", "hvad", "hvem", "hvor", "hvornår", "om", "og", "eller", "er", "en", "et", "den", "det", "de", "i", "på", "til", "med", "for", "af", "it", "this", "that"]);
function meaningful(q: string): boolean {
  return q.split(/\s+/).some((w) => w.length > 1 && !STOP.has(w.toLowerCase()));
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/* ── SSRF guard ───────────────────────────────────────────────────────────────────────────────────────────── */

/** Private, loopback, link-local, CGNAT, multicast and reserved IPv4. */
export function privateIPv4(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}

/** Loopback, unspecified, unique-local, link-local, and IPv4-mapped/compatible private IPv6. */
export function privateIPv6(ip: string): boolean {
  const v = ip.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
  if (v === "::1" || v === "::" || /^0*:0*:0*:0*:0*:0*:0*:0*1?$/.test(v)) return true;
  if (/^f[cd]/.test(v) || /^fe[89ab]/.test(v) || v.startsWith("ff")) return true;
  const mapped = /^(?:0*:)*(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  if (mapped) return privateIPv4(mapped[1]);
  const hexMapped = /^(?:0*:)*ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v);
  if (hexMapped) {
    const hi = parseInt(hexMapped[1], 16), lo = parseInt(hexMapped[2], 16);
    return privateIPv4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return v.startsWith("64:ff9b:") || v.startsWith("2001:db8");
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
/** Hosts written as one number, hex or octal ("2130706433", "0x7f.1", "0177.0.0.1"): browsers read them as IPs. */
const NUMERIC_HOST = /^(0x[0-9a-f]+|\d+)(\.(0x[0-9a-f]+|\d+)){0,3}$/i;
const INTERNAL_NAME = /(^|\.)(localhost|local|internal|intranet|lan|home|corp|home\.arpa|localdomain)$/i;

export type UrlCheck = { ok: true; url: string; host: string; local: boolean } | { ok: false; reason: "invalid" | "scheme" | "credentials" | "private" | "port" };

/**
 * May this URL be read? Public http(s) only: no credentials, no private/loopback/link-local addresses, no internal
 * names, no odd numeric hosts, ports 80/443 (or none). In development, `localhost` / 127.0.0.1 / ::1 are allowed so
 * the app can read its own pages. DNS is checked separately (see guard.ts), since a public name can point inside.
 */
export function checkUrl(raw: string, opts: { dev?: boolean } = {}): UrlCheck {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return { ok: false, reason: "invalid" }; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, reason: "scheme" };
  if (u.username || u.password) return { ok: false, reason: "credentials" };
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  const loopbackName = host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (opts.dev && loopbackName) return { ok: true, url: u.toString(), host, local: true };
  if (!host || INTERNAL_NAME.test(host) || !host.includes(".") && !host.includes(":")) return { ok: false, reason: "private" };
  if (host.includes(":")) { if (privateIPv6(host)) return { ok: false, reason: "private" }; }
  else if (IPV4.test(host)) { if (privateIPv4(host)) return { ok: false, reason: "private" }; }
  else if (NUMERIC_HOST.test(host)) return { ok: false, reason: "private" };
  if (u.port && u.port !== "80" && u.port !== "443") return { ok: false, reason: "port" };
  u.hash = "";
  return { ok: true, url: u.toString(), host: host.replace(/^www\./, ""), local: false };
}

/* ── Pages → passages, sources and context ────────────────────────────────────────────────────────────────── */

export type PagePassage = { text: string; charStart: number; charEnd: number };

/** A page's text in ~1200-character passages at paragraph or sentence breaks, with offsets into the text. */
export function chunkPage(text: string, size = 1200): PagePassage[] {
  const out: PagePassage[] = [];
  let start = 0;
  const t = text;
  while (start < t.length) {
    let end = Math.min(t.length, start + size);
    if (end < t.length) {
      const window = t.slice(start, end);
      const para = window.lastIndexOf("\n\n");
      const sentence = Math.max(window.lastIndexOf(". "), window.lastIndexOf(".\n"));
      const cut = para > size * 0.4 ? para : sentence > size * 0.4 ? sentence + 1 : window.lastIndexOf(" ");
      if (cut > 0) end = start + cut;
    }
    const piece = t.slice(start, end).trim();
    if (piece) out.push({ text: piece, charStart: start, charEnd: end });
    start = end;
    while (start < t.length && /\s/.test(t[start])) start++;
  }
  return out;
}

const words = (s: string) => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2 && !STOP.has(w));

/** The passages that share most words with the question (the first passage breaks ties: pages lead with the point). */
export function pickPassages(passages: PagePassage[], question: string, n = 2): PagePassage[] {
  const q = new Set(words(question));
  return passages
    .map((p, i) => ({ p, i, score: words(p.text).filter((w) => q.has(w)).length + (i === 0 ? 0.5 : 0) }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, n)
    .sort((a, b) => a.i - b.i)
    .map((x) => x.p);
}

export type ReadPage = {
  url: string; title: string; text: string;
  /** "read" = the page's words through mux's reader; "snippet" = the search engine's extract (the page refused us). */
  via: "read" | "snippet";
  engine?: string | null; published?: string | null; snippet?: string;
};

/** "example.com" from a URL. */
export function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}

/** The citation title of a web page: "Title · example.com". */
export function webTitle(page: Pick<ReadPage, "url" | "title">): string {
  const host = hostOf(page.url);
  const t = page.title.replace(/\s+/g, " ").trim();
  return (t && t !== page.url ? `${t.slice(0, 160)} · ${host}` : host).slice(0, 250);
}

/** The `sources` row for a page read: kind "web" in the viewer's current graph, private to them. */
export function webSourceValues(
  v: { id: string; graphId: string; graphHouseholdId: string },
  page: ReadPage,
  ctx: { query: string | null; fetchedAt: Date; conversationId?: string | null },
) {
  return {
    householdId: v.graphHouseholdId, graphId: v.graphId, ownerId: v.id, kind: "web" as const,
    title: webTitle(page), mime: "text/plain", url: page.url, fetchedAt: ctx.fetchedAt,
    textContent: page.text.slice(0, 200_000), status: "ready" as const, visibility: "private" as const, sensitive: false,
    meta: {
      docKind: "web_page", host: hostOf(page.url), query: ctx.query, via: page.via, engine: page.engine ?? null,
      published: page.published ?? null, snippet: page.snippet ?? null, conversationId: ctx.conversationId ?? null,
      fetchedAt: ctx.fetchedAt.toISOString(), extraction: "skipped: web pages are read on request; facts are proposed as a change set",
    } as Record<string, unknown>,
  };
}

/* ── Facts read on the web → a change set ─────────────────────────────────────────────────────────────────── */

export type WebFact =
  | { type: "detail"; about: string; key: string; value: string; quote: string; url: string; confidence: number }
  | { type: "relation"; about: string; relation: string; to: string; quote: string; url: string; confidence: number }
  | { type: "summary"; about: string; value: string; quote: string; url: string; confidence: number };

export type FactNode = { id: string; label: string; type: string; summary: string | null; props: Record<string, unknown>; attributes: string[] };
export type FactPage = { url: string; sourceId: string; text: string };

const norm = (s: string) => s.toLowerCase().replace(/[“”„"«»]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim();

/** Does the page really say this? The quote must be in the page's text (spacing, case and quote marks aside). */
export function quoteOnPage(quote: string, pageText: string): boolean {
  const q = norm(quote);
  return q.length >= 8 && norm(pageText).includes(q);
}

/**
 * Does the quote back the value? A detail's quote must contain the value, or most of its words and every number in
 * it ("31 December 2030" for "2030-12-31" is not enough; "December 31, 2030" for "December 31, 2030" is). A quote that
 * only names the thing ("SAP S/4HANA") backs nothing.
 */
export function valueInQuote(value: string, quote: string): boolean {
  const q = norm(quote), v = norm(value);
  if (!v) return false;
  if (q.includes(v)) return true;
  const words = v.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3 || /\d/.test(w));
  if (!words.length) return false;
  const numbers = words.filter((w) => /\d/.test(w));
  if (numbers.some((n) => !q.includes(n))) return false;
  const hit = words.filter((w) => q.includes(w)).length;
  return hit / words.length >= 0.6;
}

/** A model's answer → facts (anything malformed is dropped). */
export function parseWebFacts(raw: unknown): WebFact[] {
  const list = Array.isArray(raw) ? raw : Array.isArray((raw as { facts?: unknown })?.facts) ? (raw as { facts: unknown[] }).facts : [];
  const out: WebFact[] = [];
  const str = (x: unknown, n: number) => (typeof x === "string" ? x.replace(/\s+/g, " ").trim().slice(0, n) : "");
  for (const f of list as Record<string, unknown>[]) {
    if (!f || typeof f !== "object") continue;
    const base = { about: str(f.about, 64), quote: str(f.quote, 500), url: str(f.url, 2000), confidence: Math.max(0, Math.min(1, Number(f.confidence) || 0)) };
    if (!base.about || !base.quote || !base.url) continue;
    if (f.type === "detail" && str(f.key, 64) && str(f.value, 300)) out.push({ type: "detail", ...base, key: str(f.key, 64), value: str(f.value, 300) });
    else if (f.type === "relation" && str(f.relation, 64) && str(f.to, 64)) out.push({ type: "relation", ...base, relation: str(f.relation, 64), to: str(f.to, 64) });
    else if (f.type === "summary" && str(f.value, 400)) out.push({ type: "summary", ...base, value: str(f.value, 400) });
  }
  return out.slice(0, 20);
}

/** Public details a place, organisation, project or thing may get from the web even when its kind lacks them. Never for people. */
export const PUBLIC_DETAILS: Record<string, { label: string; type: "url" | "text" | "phone" }> = {
  website: { label: "Website", type: "url" },
  opening_hours: { label: "Opening hours", type: "text" },
  phone: { label: "Phone", type: "phone" },
  address: { label: "Address", type: "text" },
  founded: { label: "Founded", type: "text" },
};

/**
 * Facts → change-set ops. Kept only when: the fact is about a node we showed the model (in this graph, readable by
 * the viewer), the URL is one of the pages read, the quote is on that page (and, for a detail, contains its value), confidence ≥ 0.5, a detail is an
 * attribute the node's kind carries (or, for non-people, one of PUBLIC_DETAILS, proposed with the attribute) and differs from what the graph has, a relation is an allowed key between two
 * known nodes and isn't there yet. Every op carries a receipt {url, sourceId, quote, confidence}. Never applied here.
 */
export function webFactsToChanges(
  facts: WebFact[],
  ctx: { nodes: FactNode[]; pages: FactPage[]; relations: { key: string; label: string }[]; existingEdges?: string[]; conversationId?: string },
): ChangeInput[] {
  const nodes = new Map(ctx.nodes.map((n) => [n.id, n]));
  const pages = new Map(ctx.pages.map((p) => [p.url, p]));
  const relations = new Map(ctx.relations.map((r) => [r.key, r]));
  const edges = new Set(ctx.existingEdges ?? []);
  const out: ChangeInput[] = [];
  const props = new Map<string, Record<string, unknown>>();
  const summaries = new Set<string>();
  const newAttrs = new Set<string>();
  for (const f of facts) {
    const node = nodes.get(f.about);
    const page = pages.get(f.url);
    if (!node || !page || f.confidence < 0.5 || !quoteOnPage(f.quote, page.text)) continue;
    const receipt = { url: page.url, sourceId: page.sourceId, quote: f.quote, confidence: Math.round(f.confidence * 100) / 100, ...(ctx.conversationId ? { conversationId: ctx.conversationId } : {}) };
    if (f.type === "detail") {
      if (!valueInQuote(f.value, f.quote)) continue;
      const extra = !node.attributes.includes(f.key) ? PUBLIC_DETAILS[f.key] : undefined;
      if (!node.attributes.includes(f.key) && (!extra || node.type === "person")) continue;
      const have = node.props[f.key];
      if (have != null && norm(String(have)) === norm(f.value)) continue;
      const p = props.get(node.id) ?? {};
      if (f.key in p) continue;
      p[f.key] = f.value;
      props.set(node.id, p);
      // A public detail the kind doesn't carry yet (a place's website): propose the attribute too, once per type.
      if (extra && !newAttrs.has(`${node.type}:${f.key}`)) {
        newAttrs.add(`${node.type}:${f.key}`);
        out.push({ op: "addAttribute", nodeType: node.type, kindKey: null, key: f.key, label: extra.label, type: extra.type, note: `New detail “${extra.label}”`, receipt });
      }
      out.push({ op: "updateNode", nodeId: node.id, set: { props: { [f.key]: f.value } }, note: `${node.label}: ${f.key.replace(/_/g, " ")} → ${f.value} (from ${hostOf(page.url)})`, receipt });
    } else if (f.type === "relation") {
      const to = nodes.get(f.to);
      const rel = relations.get(f.relation);
      if (!to || !rel || to.id === node.id) continue;
      const key = `${node.id}|${rel.key}|${to.id}`;
      if (edges.has(key)) continue;
      edges.add(key);
      out.push({ op: "addEdge", fromId: node.id, toId: to.id, relation: rel.key, confidence: receipt.confidence, status: "unconfirmed", note: `${node.label} ${rel.label} ${to.label} (from ${hostOf(page.url)})`, receipt });
    } else {
      if (node.summary?.trim() || summaries.has(node.id)) continue;
      summaries.add(node.id);
      out.push({ op: "updateNode", nodeId: node.id, set: { summary: f.value }, note: `${node.label}: description (from ${hostOf(page.url)})`, receipt });
    }
  }
  return out.slice(0, 16);
}
