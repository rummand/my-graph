/**
 * TipTap document helpers. Pure — shared by the server (validation, text extraction, graph sync) and the client
 * (read view rendering).
 *
 * Two inline atoms carry links:
 *   mention  — @-mention of a graph node: attrs { id: node id, label, nodeType }
 *   pageLink — [[link]] to another wiki page: attrs { id: page id, label: title at link time, slug }
 */

export type DocMark = { type: string; attrs?: Record<string, unknown> };
export type DocNode = {
  type: string;
  attrs?: Record<string, unknown>;
  content?: DocNode[];
  text?: string;
  marks?: DocMark[];
};
export type Doc = DocNode & { type: "doc" };

export type Mention = { id: string; label: string; nodeType: string | null };
export type PageLink = { id: string; label: string; slug: string | null };

export const EMPTY_DOC: Doc = { type: "doc", content: [{ type: "paragraph" }] };

const BLOCKS = new Set([
  "paragraph", "heading", "bulletList", "orderedList", "listItem", "taskList", "taskItem", "blockquote", "codeBlock", "horizontalRule",
]);
const INLINE = new Set(["text", "hardBreak", "mention", "pageLink"]);
const MARKS = new Set(["bold", "italic", "strike", "code", "underline", "link"]);

export const MAX_DOC_BYTES = 1_000_000;
const MAX_DEPTH = 40;

/** Links may point to the web, mail, phone, or somewhere inside the app — never javascript: or data:. */
export function safeHref(href: unknown): string | null {
  if (typeof href !== "string") return null;
  const h = href.trim();
  if (!h || h.length > 2000) return null;
  if (h.startsWith("/") && !h.startsWith("//")) return h;
  if (h.startsWith("#")) return h;
  try {
    const u = new URL(h);
    return ["http:", "https:", "mailto:", "tel:"].includes(u.protocol) ? u.toString() : null;
  } catch {
    return null;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const str = (v: unknown, max = 500) => (typeof v === "string" ? v.slice(0, max) : null);

export class DocError extends Error {}

function cleanMarks(marks: unknown): DocMark[] | undefined {
  if (!Array.isArray(marks)) return undefined;
  const out: DocMark[] = [];
  for (const m of marks) {
    if (!m || typeof m !== "object") continue;
    const type = (m as DocMark).type;
    if (!MARKS.has(type)) continue;
    if (type === "link") {
      const href = safeHref((m as DocMark).attrs?.href);
      if (href) out.push({ type, attrs: { href } });
    } else out.push({ type });
  }
  return out.length ? out : undefined;
}

function cleanAttrs(type: string, a: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const attrs = a ?? {};
  switch (type) {
    case "heading": {
      const level = Number(attrs.level);
      return { level: level >= 1 && level <= 6 ? Math.trunc(level) : 2 };
    }
    case "orderedList": {
      const start = Number(attrs.start);
      return { start: Number.isFinite(start) && start >= 0 ? Math.trunc(start) : 1 };
    }
    case "taskItem":
      return { checked: attrs.checked === true };
    case "codeBlock":
      return { language: str(attrs.language, 40) };
    case "mention": {
      const id = str(attrs.id, 64);
      if (!id || !UUID.test(id)) throw new DocError("A mention points to something that doesn't exist.");
      return { id, label: str(attrs.label, 300) ?? "", nodeType: str(attrs.nodeType, 20) };
    }
    case "pageLink": {
      const id = str(attrs.id, 64);
      if (!id || !UUID.test(id)) throw new DocError("A page link points to a page that doesn't exist.");
      return { id, label: str(attrs.label, 300) ?? "", slug: str(attrs.slug, 120) };
    }
    default:
      return undefined;
  }
}

function cleanNode(raw: unknown, depth: number): DocNode | null {
  if (depth > MAX_DEPTH) throw new DocError("The page is nested too deeply.");
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const n = raw as DocNode;
  if (typeof n.type !== "string") return null;
  if (n.type === "text") {
    if (typeof n.text !== "string" || n.text.length === 0) return null;
    const marks = cleanMarks(n.marks);
    return marks ? { type: "text", text: n.text, marks } : { type: "text", text: n.text };
  }
  if (!BLOCKS.has(n.type) && !INLINE.has(n.type)) return null; // unknown node types are dropped
  const out: DocNode = { type: n.type };
  const attrs = cleanAttrs(n.type, n.attrs);
  if (attrs) out.attrs = attrs;
  if (Array.isArray(n.content) && n.type !== "mention" && n.type !== "pageLink" && n.type !== "hardBreak" && n.type !== "horizontalRule") {
    const kids = n.content.map((c) => cleanNode(c, depth + 1)).filter((c): c is DocNode => c !== null);
    if (kids.length) out.content = kids;
  }
  return out;
}

/**
 * Validate and normalise a TipTap document from the client: known nodes and marks only, safe links only, uuid ids on
 * mentions and page links. Throws DocError with a readable message when it can't be used at all.
 */
export function sanitizeDoc(raw: unknown): Doc {
  if (!raw || typeof raw !== "object" || (raw as DocNode).type !== "doc") throw new DocError("The page content isn't a document.");
  let size = 0;
  try { size = JSON.stringify(raw).length; } catch { throw new DocError("The page content couldn't be read."); }
  if (size > MAX_DOC_BYTES) throw new DocError("This page is too long to save (over 1 MB). Split it into two pages.");
  const content = Array.isArray((raw as DocNode).content)
    ? (raw as DocNode).content!.map((c) => cleanNode(c, 1)).filter((c): c is DocNode => c !== null)
    : [];
  return { type: "doc", content: content.length ? content : [{ type: "paragraph" }] };
}

function walk(n: DocNode, visit: (n: DocNode) => void) {
  visit(n);
  for (const c of n.content ?? []) walk(c, visit);
}

/** Plain text of a node's inline content (no block separators). */
function inlineText(n: DocNode): string {
  if (n.type === "text") return n.text ?? "";
  if (n.type === "hardBreak") return "\n";
  if (n.type === "mention" || n.type === "pageLink") return String(n.attrs?.label ?? "");
  return (n.content ?? []).map(inlineText).join("");
}

function blockText(n: DocNode, depth: number): string {
  switch (n.type) {
    case "paragraph":
    case "heading":
    case "codeBlock":
      return inlineText(n);
    case "horizontalRule":
      return "";
    case "taskItem":
    case "listItem": {
      const prefix = n.type === "taskItem" ? (n.attrs?.checked ? "[x] " : "[ ] ") : "- ";
      const parts = (n.content ?? []).map((c) => blockText(c, depth + 1)).filter(Boolean);
      return prefix + parts.join("\n");
    }
    default:
      if (INLINE.has(n.type)) return inlineText(n);
      return (n.content ?? []).map((c) => blockText(c, depth + 1)).filter(Boolean).join("\n");
  }
}

/** Searchable plain text: one line per block, a blank line between top-level blocks. Used for search, diff and ingest. */
export function docToText(doc: DocNode): string {
  return (doc.content ?? [])
    .map((b) => blockText(b, 0).trim())
    .filter(Boolean)
    .join("\n\n");
}

/** @-mentions of graph nodes, de-duplicated by id, in document order. */
export function extractMentions(doc: DocNode): Mention[] {
  const seen = new Map<string, Mention>();
  walk(doc, (n) => {
    if (n.type !== "mention") return;
    const id = n.attrs?.id;
    if (typeof id !== "string" || seen.has(id)) return;
    seen.set(id, { id, label: String(n.attrs?.label ?? ""), nodeType: typeof n.attrs?.nodeType === "string" ? n.attrs.nodeType : null });
  });
  return [...seen.values()];
}

/** [[links]] to other wiki pages, de-duplicated by page id, in document order. */
export function extractPageLinks(doc: DocNode): PageLink[] {
  const seen = new Map<string, PageLink>();
  walk(doc, (n) => {
    if (n.type !== "pageLink") return;
    const id = n.attrs?.id;
    if (typeof id !== "string" || seen.has(id)) return;
    seen.set(id, { id, label: String(n.attrs?.label ?? ""), slug: typeof n.attrs?.slug === "string" ? n.attrs.slug : null });
  });
  return [...seen.values()];
}

/** True when two documents are the same content (cheap structural compare via JSON). */
export function sameDoc(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** A short plain-text excerpt for lists. */
export function excerpt(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut) + "…";
}
