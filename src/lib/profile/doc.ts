/**
 * The written part of a profile (pure, shared by server and client): a TipTap document with the wiki's blocks plus
 * toggles, tables, library images and fact chips. `sanitizeProfileDoc` is the only way a doc gets stored: unknown
 * nodes are dropped, links are made safe, ids must be ids.
 *
 * Inline atoms:
 *   mention  — @-mention of a graph node { id, label, nodeType }
 *   factRef  — a fact in the graph, written from the profile { edgeId, otherId, otherLabel, otherType, phrase }
 * Blocks beyond the wiki's: toggle { summary, open } (content: blocks), table/tableRow/tableHeader/tableCell,
 * libraryImage { sourceId, alt } (served by /api/files/:id, so the viewer's access is checked on every load).
 */
import { safeHref } from "@/lib/wiki/doc";

export type DocMark = { type: string; attrs?: Record<string, unknown> };
export type DocNode = { type: string; attrs?: Record<string, unknown>; content?: DocNode[]; text?: string; marks?: DocMark[] };
export type ProfileDoc = DocNode & { type: "doc" };

export const EMPTY_PROFILE_DOC: ProfileDoc = { type: "doc", content: [{ type: "paragraph" }] };
export const MAX_PROFILE_DOC_BYTES = 500_000;
const MAX_DEPTH = 30;

const BLOCKS = new Set([
  "paragraph", "heading", "bulletList", "orderedList", "listItem", "taskList", "taskItem", "blockquote", "codeBlock", "horizontalRule",
  "toggle", "table", "tableRow", "tableHeader", "tableCell", "libraryImage",
]);
const INLINE = new Set(["text", "hardBreak", "mention", "factRef"]);
const MARKS = new Set(["bold", "italic", "strike", "code", "underline", "link", "highlight"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const str = (v: unknown, max = 300) => (typeof v === "string" ? v.slice(0, max) : null);
const id = (v: unknown) => (typeof v === "string" && UUID.test(v) ? v.toLowerCase() : null);

export class ProfileDocError extends Error {}

function cleanMarks(marks: unknown): DocMark[] | undefined {
  if (!Array.isArray(marks)) return undefined;
  const out: DocMark[] = [];
  for (const m of marks) {
    const type = (m as DocMark | null)?.type;
    if (typeof type !== "string" || !MARKS.has(type) || type === "highlight") continue;
    if (type === "link") {
      const href = safeHref((m as DocMark).attrs?.href);
      if (href) out.push({ type, attrs: { href } });
    } else out.push({ type });
  }
  return out.length ? out : undefined;
}

function cleanAttrs(type: string, a: Record<string, unknown> = {}): Record<string, unknown> | undefined | null {
  switch (type) {
    case "heading": { const l = Number(a.level); return { level: l === 3 ? 3 : 2 }; }
    case "orderedList": { const s = Number(a.start); return { start: Number.isFinite(s) && s >= 0 ? Math.trunc(s) : 1 }; }
    case "taskItem": return { checked: a.checked === true };
    case "codeBlock": return { language: str(a.language, 40) };
    case "toggle": return { summary: str(a.summary, 200) ?? "", open: a.open === true };
    case "tableCell": case "tableHeader": {
      const n = (x: unknown) => { const v = Number(x); return Number.isFinite(v) && v >= 1 && v <= 20 ? Math.trunc(v) : 1; };
      return { colspan: n(a.colspan), rowspan: n(a.rowspan), colwidth: null };
    }
    case "libraryImage": {
      const sourceId = id(a.sourceId);
      return sourceId ? { sourceId, alt: str(a.alt, 200) ?? "" } : null;
    }
    case "mention": {
      const nodeId = id(a.id);
      return nodeId ? { id: nodeId, label: str(a.label, 120) ?? "", nodeType: str(a.nodeType, 30) } : null;
    }
    case "factRef": {
      const otherId = id(a.otherId);
      return otherId ? {
        edgeId: id(a.edgeId), otherId, otherLabel: str(a.otherLabel, 120) ?? "", otherType: str(a.otherType, 30) ?? "thing", phrase: str(a.phrase, 120) ?? "",
      } : null;
    }
    default: return undefined;
  }
}

function cleanNode(raw: unknown, depth: number): DocNode | null {
  if (!raw || typeof raw !== "object" || depth > MAX_DEPTH) return null;
  const n = raw as DocNode;
  if (typeof n.type !== "string") return null;
  if (n.type === "text") {
    const text = typeof n.text === "string" ? n.text.slice(0, 20_000) : "";
    if (!text) return null;
    const marks = cleanMarks(n.marks);
    return marks ? { type: "text", text, marks } : { type: "text", text };
  }
  if (!BLOCKS.has(n.type) && !INLINE.has(n.type)) return null;
  const attrs = cleanAttrs(n.type, n.attrs);
  if (attrs === null) return null;
  const out: DocNode = { type: n.type };
  if (attrs) out.attrs = attrs;
  if (Array.isArray(n.content) && !["mention", "factRef", "libraryImage", "horizontalRule", "hardBreak"].includes(n.type)) {
    const content = n.content.map((c) => cleanNode(c, depth + 1)).filter((c): c is DocNode => !!c);
    if (content.length) out.content = content;
  }
  // Containers that ProseMirror requires to hold something get an empty paragraph rather than being invalid.
  if (["listItem", "taskItem", "blockquote", "toggle", "tableCell", "tableHeader"].includes(n.type) && !out.content?.length) out.content = [{ type: "paragraph" }];
  if (["bulletList", "orderedList", "taskList", "table", "tableRow"].includes(n.type) && !out.content?.length) return null;
  return out;
}

/** The stored form of a doc from the browser. Throws ProfileDocError when it isn't a doc or is far too large. */
export function sanitizeProfileDoc(raw: unknown): ProfileDoc {
  if (!raw || typeof raw !== "object" || (raw as DocNode).type !== "doc") throw new ProfileDocError("That isn't a profile document.");
  if (JSON.stringify(raw).length > MAX_PROFILE_DOC_BYTES) throw new ProfileDocError("This profile text is too long to save. Split it up or move some of it to a wiki page.");
  const content = ((raw as DocNode).content ?? []).map((c) => cleanNode(c, 1)).filter((c): c is DocNode => !!c && BLOCKS.has(c.type));
  return { type: "doc", content: content.length ? content : [{ type: "paragraph" }] };
}

/** Plain text of a doc (for search, version sizes, the highlighter and insights). */
export function profileDocText(doc: DocNode): string {
  const parts: string[] = [];
  const walk = (n: DocNode) => {
    if (n.type === "text") { parts.push(n.text ?? ""); return; }
    if (n.type === "mention") { parts.push(String(n.attrs?.label ?? "")); return; }
    if (n.type === "factRef") { parts.push(`${n.attrs?.phrase ?? ""} ${n.attrs?.otherLabel ?? ""}`.trim()); return; }
    if (n.type === "hardBreak") { parts.push("\n"); return; }
    if (n.type === "toggle" && n.attrs?.summary) parts.push(`${n.attrs.summary}\n`);
    for (const c of n.content ?? []) walk(c);
    if (BLOCKS.has(n.type) && !["listItem", "tableRow", "table"].includes(n.type)) parts.push("\n");
    if (n.type === "tableCell" || n.type === "tableHeader") parts.push("\t");
  };
  walk(doc);
  return parts.join("").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Node ids the doc mentions (mentions and fact chips), unique, in order. */
export function profileDocNodeIds(doc: DocNode): string[] {
  const out: string[] = [];
  const walk = (n: DocNode) => {
    const nid = n.type === "mention" ? n.attrs?.id : n.type === "factRef" ? n.attrs?.otherId : null;
    if (typeof nid === "string" && !out.includes(nid)) out.push(nid);
    for (const c of n.content ?? []) walk(c);
  };
  walk(doc);
  return out;
}

/** Library images the doc shows. */
export function profileDocSourceIds(doc: DocNode): string[] {
  const out: string[] = [];
  const walk = (n: DocNode) => {
    if (n.type === "libraryImage" && typeof n.attrs?.sourceId === "string" && !out.includes(n.attrs.sourceId)) out.push(n.attrs.sourceId);
    for (const c of n.content ?? []) walk(c);
  };
  walk(doc);
  return out;
}

/** Stable JSON (sorted keys) so equal docs compare equal whatever order the editor wrote attributes in. */
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as Record<string, unknown>).filter((k) => (v as Record<string, unknown>)[k] !== undefined).sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

export function sameDoc(a: DocNode, b: DocNode): boolean {
  return stableJson(a) === stableJson(b);
}

/**
 * What a save does to the version line: nothing (same text), a fresh doc at version 1, or the next version. A save
 * based on an older version than the one stored is a conflict (someone else saved in between), unless it is the same
 * text.
 */
export function planSave(current: { version: number; doc: DocNode } | null, next: DocNode, baseVersion: number | null):
  { kind: "unchanged"; version: number } | { kind: "conflict"; version: number } | { kind: "save"; version: number } {
  if (!current) return sameDoc(next, EMPTY_PROFILE_DOC) ? { kind: "unchanged", version: 0 } : { kind: "save", version: 1 };
  if (sameDoc(current.doc, next)) return { kind: "unchanged", version: current.version };
  if (baseVersion !== null && baseVersion !== current.version) return { kind: "conflict", version: current.version };
  return { kind: "save", version: current.version + 1 };
}

/** Words changed between two versions, roughly (for "changed 12 words" in the history). */
export function wordDelta(a: string, b: string): { added: number; removed: number } {
  const count = (s: string) => {
    const m = new Map<string, number>();
    for (const w of s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)) m.set(w, (m.get(w) ?? 0) + 1);
    return m;
  };
  const ca = count(a), cb = count(b);
  let added = 0, removed = 0;
  for (const [w, n] of cb) added += Math.max(0, n - (ca.get(w) ?? 0));
  for (const [w, n] of ca) removed += Math.max(0, n - (cb.get(w) ?? 0));
  return { added, removed };
}
