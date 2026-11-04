// Parsing RSS 2.0 and Atom feeds, without dependencies (pure: no I/O). Good enough for real-world feeds: CDATA,
// entities, Atom links, dates in RFC 822 or ISO 8601. Not a general XML parser.

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decode(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, c) => c)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeChar(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}
function safeChar(n) { try { return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ""; } catch { return ""; } }

/** HTML to plain text (feeds put HTML in descriptions). */
export function text(html) {
  return decode(html ?? "")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  return m ? decode(m[1]).trim() : "";
}
function attr(tagText, name) {
  const m = tagText.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i"));
  return m ? decode(m[2] ?? m[3] ?? "") : "";
}
function blocks(xml, name) {
  return [...xml.matchAll(new RegExp(`<${name}(?:\\s[^>]*)?>[\\s\\S]*?</${name}>`, "gi"))].map((m) => m[0]);
}
function isoDate(s) {
  if (!s) return undefined;
  const d = new Date(s.trim());
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** A feed's title and items, newest first. Throws when it is neither RSS nor Atom. */
export function parseFeed(xml) {
  const src = String(xml ?? "");
  const isAtom = /<feed[\s>]/i.test(src) && /xmlns\s*=\s*["']http:\/\/www\.w3\.org\/2005\/Atom/i.test(src);
  const isRss = /<rss[\s>]|<rdf:RDF[\s>]/i.test(src);
  if (!isAtom && !isRss) throw new Error("This address doesn't return an RSS or Atom feed.");
  const items = [];
  if (isAtom) {
    const head = src.split(/<entry[\s>]/i)[0];
    const title = tag(head, "title");
    for (const e of blocks(src, "entry")) {
      const links = [...e.matchAll(/<link\b[^>]*\/?>/gi)].map((m) => m[0]);
      const alt = links.find((l) => !/rel\s*=/.test(l) || /rel\s*=\s*["']alternate["']/i.test(l)) ?? links[0] ?? "";
      const url = attr(alt, "href");
      const id = tag(e, "id") || url;
      items.push({ id, title: text(tag(e, "title")) || "(untitled)", url, date: isoDate(tag(e, "published") || tag(e, "updated")), text: text(tag(e, "content") || tag(e, "summary")), author: text(tag(tag(e, "author") ? e : "", "name")) || undefined });
    }
    return { title, items: sortNewest(items) };
  }
  const channel = tag(src, "channel") || src;
  const title = tag(channel.split(/<item[\s>]/i)[0], "title");
  for (const it of blocks(src, "item")) {
    const url = tag(it, "link");
    const id = tag(it, "guid") || url || tag(it, "title");
    items.push({ id, title: text(tag(it, "title")) || "(untitled)", url, date: isoDate(tag(it, "pubDate") || tag(it, "dc:date")), text: text(tag(it, "content:encoded") || tag(it, "description")), author: text(tag(it, "dc:creator") || tag(it, "author")) || undefined });
  }
  return { title, items: sortNewest(items) };
}

function sortNewest(items) {
  return items.filter((i) => i.id).sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
}

/**
 * Which items are new since the cursor: not among the ids seen before. The cursor keeps the last 300 ids seen (feeds
 * show a window of recent items) and the feed's ETag and Last-Modified for a conditional request.
 */
export function newItems(items, cursor, maxItems = 50) {
  const seen = new Set(Array.isArray(cursor?.seen) ? cursor.seen : []);
  const fresh = items.filter((i) => !seen.has(i.id)).slice(0, maxItems);
  const next = [...new Set([...items.map((i) => i.id), ...seen])].slice(0, 300);
  return { fresh, seen: next };
}
