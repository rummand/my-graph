/**
 * What a paste into the library is (pure: the upload zone and its tests use it).
 *
 *   files  files copied in Finder or Explorer, screenshots, images copied from a page
 *   url    a web address on its own: the page is read and saved as a web page
 *   text   plain or rich text: saved as a note, with the page it was copied from when the clipboard says
 */

export type PasteChoice =
  | { kind: "files"; files: File[] }
  | { kind: "url"; url: string; title: string | null }
  | { kind: "text"; text: string; sourceUrl: string | null }
  | { kind: "none" };

/** What the clipboard holds, as plain values (from a paste event's DataTransfer or navigator.clipboard.read()). */
export type ClipboardSnapshot = {
  files: File[];
  /** text/plain */
  text?: string | null;
  /** text/html */
  html?: string | null;
  /** text/uri-list */
  uriList?: string | null;
  /** text/x-moz-url (Firefox: "url\ntitle"), or text/x-moz-url-priv (the page the selection came from). */
  mozUrl?: string | null;
  /** Focus is in a text field: text belongs to the field, only files are ours. */
  inField?: boolean;
};

const MAX_TITLE = 80;

/** A title from a note's first line ("# Packing list" → "Packing list"); null when there is nothing worth a title. */
export function titleFromText(text: string, max = MAX_TITLE): string | null {
  const line = text.split(/\r?\n/).map((l) => l.trim()).find((l) => /[\p{L}\p{N}]/u.test(l));
  if (!line) return null;
  const clean = line
    .replace(/^(#{1,6}\s+|>\s*|[-*•·–]\s+|\d{1,3}[.)]\s+|\[[ xX]\]\s+)+/u, "")
    .replace(/[*_`]{1,3}([^*_`]+)[*_`]{1,3}/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  if (clean.replace(/[^\p{L}\p{N}]/gu, "").length < 2) return null;
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,.;:–-]+$/, "")}…`;
}

/** The web address when the text is a URL and nothing else ("www.aula.dk" counts); otherwise null. */
export function soleUrl(text: string | null | undefined): string | null {
  const s = (text ?? "").trim().replace(/^<(.+)>$/, "$1");
  if (!s || s.length > 2000 || /\s/.test(s)) return null;
  const withScheme = /^www\.[^/]+\.[a-z]{2,}/i.test(s) ? `https://${s}` : s;
  if (!/^https?:\/\//i.test(withScheme)) return null;
  try {
    const u = new URL(withScheme);
    if (!u.hostname || (!u.hostname.includes(".") && u.hostname !== "localhost")) return null;
    if (u.username || u.password) return null;
    return u.toString();
  } catch {
    return null;
  }
}

/** The page a copied selection came from, if the clipboard says (text/x-moz-url, text/uri-list). */
export function sourceUrlOf(s: Pick<ClipboardSnapshot, "uriList" | "mozUrl">): { url: string; title: string | null } | null {
  if (s.mozUrl) {
    const [first, second] = s.mozUrl.split(/\r?\n/);
    const url = soleUrl(first);
    if (url) return { url, title: second?.trim() || null };
  }
  if (s.uriList) {
    const line = s.uriList.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith("#"));
    const url = soleUrl(line);
    if (url) return { url, title: null };
  }
  return null;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", aelig: "æ", oslash: "ø", aring: "å", AElig: "Æ", Oslash: "Ø", Aring: "Å" };

/** Readable text from copied HTML: paragraphs and list items keep their line breaks, scripts and styles go. */
export function htmlToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|template|head)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/(p|div|h[1-6]|tr|section|article|blockquote|pre|ul|ol|table)>/gi, "\n\n")
    .replace(/<\/(td|th)>/gi, "\t")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === "#") {
        const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
      }
      return ENTITIES[e] ?? ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t ]+\n/g, "\n")
    .replace(/[  ]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Text lines that are only file names: what Finder and Explorer put next to copied files. */
const looksLikeFileNames = (text: string, files: File[]) => {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return false;
  const names = new Set(files.map((f) => f.name));
  return lines.every((l) => names.has(l) || /^[^/\\\n]{1,200}\.[A-Za-z0-9]{1,5}$/.test(l));
};

/**
 * Decide what a paste is.
 * Files win, except when the only "files" are a picture of copied text (Word, Excel and Numbers put a rendering of the
 * selection next to the words): then the words are what was meant.
 */
export function choosePaste(s: ClipboardSnapshot): PasteChoice {
  const plain = (s.text ?? "").replace(/\r\n/g, "\n");
  const files = s.files.filter((f) => f.size > 0 || f.name);
  if (files.length) {
    const imagesOnly = files.every((f) => f.type.startsWith("image/"));
    const words = plain.trim();
    const textMeant = !s.inField && imagesOnly && words.length > 0 && !soleUrl(words) && !looksLikeFileNames(words, files) && !!s.html;
    if (!textMeant) return { kind: "files", files };
  }
  if (s.inField) return { kind: "none" };

  const text = plain.trim() ? plain : s.html ? htmlToText(s.html) : "";
  if (!text.trim()) {
    const link = sourceUrlOf(s);
    return link ? { kind: "url", url: link.url, title: link.title } : { kind: "none" };
  }
  const url = soleUrl(text);
  if (url) {
    const link = sourceUrlOf(s);
    return { kind: "url", url, title: link && link.url === url ? link.title : null };
  }
  return { kind: "text", text: text.trim(), sourceUrl: sourceUrlOf(s)?.url ?? null };
}

/** All files of a paste, from `files` and from `items` of kind "file" (browsers fill one or the other), once each. */
export function pastedFiles(dt: Pick<DataTransfer, "files" | "items"> | null | undefined): File[] {
  if (!dt) return [];
  const out: File[] = [];
  // The same file read twice (once from each list) differs at most in lastModified.
  const seen = new Set<string>();
  const add = (f: File | null) => {
    if (!f) return;
    const key = `${f.name}|${f.size}|${f.type}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(f);
  };
  for (const f of Array.from(dt.files ?? [])) add(f);
  for (const it of Array.from(dt.items ?? [])) if (it.kind === "file") add(it.getAsFile());
  return out;
}

/** Focus is somewhere text goes (an input, a text area, an editable region). */
export function isTextTarget(el: EventTarget | Element | null | undefined): boolean {
  if (!el || typeof (el as Element).closest !== "function") return false;
  const e = el as HTMLElement;
  if (e.isContentEditable) return true;
  const field = e.closest("input, textarea, select, [contenteditable=''], [contenteditable='true']");
  if (!field) return false;
  if (field.tagName === "INPUT") {
    const type = (field as HTMLInputElement).type;
    return !["button", "checkbox", "radio", "submit", "reset", "file", "range", "color", "image"].includes(type);
  }
  return true;
}

/** "Mac" for ⌘V, else Ctrl+V. */
export function isApplePlatform(nav: { platform?: string; userAgent?: string; userAgentData?: { platform?: string } } | undefined): boolean {
  const p = nav?.userAgentData?.platform || nav?.platform || nav?.userAgent || "";
  return /mac|iphone|ipad|ipod/i.test(p);
}

/** "example.com" from a web address. */
export function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}
