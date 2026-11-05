/**
 * Co-writing: where the assistant's text sits in the page and how to take it back. Pure ProseMirror (no DOM), so the
 * editor plugin and the tests share it.
 *
 * The assistant always owns one range of whole top-level blocks, [from, to). While it writes, each new render
 * replaces that range. The person keeps editing elsewhere; their edits move the range (mapEdit). Undo puts the
 * original blocks back (revertEdit), so it removes exactly the assistant's text and nothing the person wrote outside
 * it. Autosave stores the page as if the assistant hadn't written yet (docWithoutEdit) until the person accepts.
 */
import { Fragment, Slice, type Node as PMNode, type Schema } from "@tiptap/pm/model";
import { Transform, type Mappable } from "@tiptap/pm/transform";
import type { DocNode } from "../doc";
import type { CowriteMode } from "./prompt";

export type PendingEdit = {
  id: string;
  mode: CowriteMode;
  from: number;
  to: number;
  /** What was in [from, to) before the assistant started (empty for a new section). */
  original: Slice;
};

/** Index and start position of the top-level block containing `pos`. */
function topLevelAt(doc: PMNode, pos: number): { index: number; start: number; end: number } {
  const p = Math.max(0, Math.min(pos, doc.content.size));
  let start = 0;
  for (let i = 0; i < doc.childCount; i++) {
    const end = start + doc.child(i).nodeSize;
    if (p < end || i === doc.childCount - 1) return { index: i, start, end };
    start = end;
  }
  return { index: 0, start: 0, end: 0 };
}

/** Where a new section goes: right after the top-level block holding the cursor (never splitting a paragraph). */
export function insertionPoint(doc: PMNode, pos: number): number {
  if (!doc.childCount) return 0;
  const b = topLevelAt(doc, pos);
  // An empty paragraph at the cursor: write over it rather than after it.
  const node = doc.child(b.index);
  if (node.type.name === "paragraph" && node.content.size === 0) return b.start;
  return b.end;
}

/** The whole top-level blocks a selection touches. */
export function blockRange(doc: PMNode, from: number, to: number): { from: number; to: number } {
  const a = topLevelAt(doc, Math.min(from, to));
  const b = topLevelAt(doc, Math.max(from, to) - (to > from ? 1 : 0));
  return { from: a.start, to: Math.max(a.end, b.end) };
}

let seq = 0;
const newId = () => `cw-${Date.now().toString(36)}-${(seq++).toString(36)}`;

/** Start a pending edit for a mode: an empty range at the cursor, the selected blocks, or the whole page. */
export function beginEdit(doc: PMNode, mode: CowriteMode, sel: { from: number; to: number }): PendingEdit {
  if (mode === "page") return { id: newId(), mode, from: 0, to: doc.content.size, original: doc.slice(0, doc.content.size) };
  if (mode === "rewrite" && sel.to > sel.from) {
    const r = blockRange(doc, sel.from, sel.to);
    return { id: newId(), mode, ...r, original: doc.slice(r.from, r.to) };
  }
  const at = insertionPoint(doc, sel.from);
  // Writing over an empty paragraph: that paragraph is the original, so Undo brings the blank line back.
  const node = doc.childCount ? doc.nodeAt(at) : null;
  if (node && node.type.name === "paragraph" && node.content.size === 0 && at < doc.content.size) {
    return { id: newId(), mode: "insert", from: at, to: at + node.nodeSize, original: doc.slice(at, at + node.nodeSize) };
  }
  return { id: newId(), mode: "insert", from: at, to: at, original: Slice.empty };
}

/** The person's edits move the range; typing right at its edges stays outside it. */
export function mapEdit(edit: PendingEdit, mapping: Mappable): PendingEdit {
  const from = mapping.map(edit.from, 1);
  const to = Math.max(from, mapping.map(edit.to, -1));
  return from === edit.from && to === edit.to ? edit : { ...edit, from, to };
}

/** Blocks → a fragment the schema accepts; falls back to plain paragraphs if a block doesn't fit. */
export function blocksToFragment(schema: Schema, blocks: DocNode[]): Fragment {
  const nodes: PMNode[] = [];
  for (const b of blocks) {
    try {
      const n = schema.nodeFromJSON(b);
      n.check();
      nodes.push(n);
    } catch {
      const t = plainText(b).trim();
      if (t) nodes.push(schema.nodes.paragraph.create(null, schema.text(t)));
    }
  }
  return Fragment.fromArray(nodes);
}

function plainText(n: DocNode): string {
  if (n.type === "text") return n.text ?? "";
  if (n.type === "mention" || n.type === "pageLink") return String(n.attrs?.label ?? "");
  return (n.content ?? []).map(plainText).join(" ");
}

/**
 * Replace the assistant's range with its latest render. Returns the edit's new range. The whole page must keep at
 * least one block, so an empty render of the whole page leaves an empty paragraph.
 */
export function renderInto(tr: Transform, edit: PendingEdit, fragment: Fragment): PendingEdit {
  const schema = tr.doc.type.schema;
  let frag = fragment;
  if (frag.size === 0 && edit.from === 0 && edit.to === tr.doc.content.size) frag = Fragment.from(schema.nodes.paragraph.create());
  tr.replaceWith(edit.from, edit.to, frag);
  return { ...edit, to: edit.from + frag.size };
}

/** Put back what was there before the assistant wrote. */
export function revertEdit(tr: Transform, edit: PendingEdit): void {
  const size = tr.doc.content.size;
  const from = Math.min(edit.from, size);
  const to = Math.min(Math.max(edit.to, from), size);
  if (from === to && edit.original.size === 0) return;
  if (from === 0 && to === size && edit.original.size === 0) {
    tr.replaceWith(0, size, tr.doc.type.schema.nodes.paragraph.create());
    return;
  }
  tr.replace(from, to, edit.original);
}

/** The page as if the assistant hadn't written: what autosave stores until the person accepts. */
export function docWithoutEdit(doc: PMNode, edit: PendingEdit | null): PMNode {
  if (!edit) return doc;
  const tr = new Transform(doc);
  revertEdit(tr, edit);
  return tr.doc;
}

/** True when a transaction's steps change anything inside [from, to) (used to keep hands off while it writes). */
export function touchesRange(steps: { getMap(): { forEach(f: (oldStart: number, oldEnd: number) => void): void; map(pos: number, assoc?: number): number } }[], from: number, to: number): boolean {
  let a = from;
  let b = to;
  for (const step of steps) {
    const map = step.getMap();
    let hit = false;
    map.forEach((s, e) => {
      // Strictly inside, or a deletion spanning into it. Inserting exactly at an edge is outside.
      if ((s < b && e > a) || (s > a && s < b)) hit = true;
    });
    if (hit) return true;
    a = map.map(a, 1);
    b = Math.max(a, map.map(b, -1));
  }
  return false;
}

/** Where to draw the assistant's caret: the end of the last text block it wrote. */
export function caretPos(doc: PMNode, edit: PendingEdit): number | null {
  let pos: number | null = null;
  const to = Math.min(edit.to, doc.content.size);
  if (to <= edit.from) return null;
  doc.nodesBetween(edit.from, to, (node, p) => {
    if (node.isTextblock) { pos = p + 1 + node.content.size; return false; }
    return true;
  });
  return pos;
}
