/**
 * Compliance marks in the page editor: a soft wavy underline (amber, brick for blockers) under the words a rule
 * check flagged, moved along as the person keeps typing, and a suggested fix shown as a pending edit (the old words
 * struck through, the new ones in cobalt) until it is accepted or discarded. Clicking flagged words dispatches a
 * `compliance-pick` DOM event with the finding's id; the live checker opens its note.
 */
import { Extension } from "@tiptap/react";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

export type Mark = { id: string; from: number; to: number; tone: "danger" | "warn" | "muted"; approx?: boolean };
export type PendingFix = { id: string; from: number; to: number; text: string; atEnd?: boolean };
type State = { marks: Mark[]; active: string | null; pending: PendingFix | null };
type Meta = Partial<State>;

export const complianceKey = new PluginKey<State>("wikiCompliance");
const EMPTY: State = { marks: [], active: null, pending: null };

export function getMarks(state: EditorState): State {
  return complianceKey.getState(state) ?? EMPTY;
}

/** Update the marks, the active one or the pending fix (never part of the person's undo history or autosave). */
export function setCompliance(tr: Transaction, meta: Meta): Transaction {
  return tr.setMeta(complianceKey, meta).setMeta("addToHistory", false);
}

export const isComplianceTr = (tr: Transaction) => !!tr.getMeta(complianceKey);

export const ComplianceMarks = Extension.create({
  name: "wikiCompliance",
  addProseMirrorPlugins() {
    return [
      new Plugin<State>({
        key: complianceKey,
        state: {
          init: () => EMPTY,
          apply(tr, prev) {
            const meta = tr.getMeta(complianceKey) as Meta | undefined;
            let s = meta ? { ...prev, ...meta } : prev;
            if (tr.docChanged && !meta) {
              const marks = s.marks.map((m) => ({ ...m, from: tr.mapping.map(m.from, 1), to: tr.mapping.map(m.to, -1) })).filter((m) => m.to > m.from);
              const p = s.pending;
              const pending = p ? { ...p, from: tr.mapping.map(p.from, 1), to: tr.mapping.map(p.to, -1) } : null;
              s = { ...s, marks, pending: pending && (pending.to >= pending.from) ? pending : null };
            }
            return s;
          },
        },
        props: {
          decorations(state) {
            const s = complianceKey.getState(state);
            if (!s || (!s.marks.length && !s.pending)) return null;
            const size = state.doc.content.size;
            const decos: Decoration[] = [];
            for (const m of s.marks) {
              if (m.from < 0 || m.to > size || m.to <= m.from) continue;
              const cls = `cmp-flag cmp-${m.tone}${m.approx ? " cmp-approx" : ""}${s.active === m.id ? " cmp-active" : ""}`;
              decos.push(Decoration.inline(m.from, m.to, { class: cls, "data-finding": m.id }));
            }
            const p = s.pending;
            if (p) {
              if (!p.atEnd && p.to > p.from && p.to <= size) decos.push(Decoration.inline(p.from, p.to, { class: "cmp-strike" }));
              const at = p.atEnd ? endOfLastText(state.doc) : Math.min(p.to, size);
              decos.push(Decoration.widget(at, () => {
                const el = document.createElement("span");
                el.className = p.atEnd ? "cmp-insert cmp-insert-block" : "cmp-insert";
                el.textContent = p.atEnd ? p.text : ` ${p.text}`;
                el.setAttribute("aria-label", p.text);
                return el;
              }, { side: 1, key: `fix-${p.id}`, ignoreSelection: true }));
            }
            return DecorationSet.create(state.doc, decos);
          },
          handleClick(view, pos) {
            const s = complianceKey.getState(view.state);
            const hit = s?.marks.find((m) => pos >= m.from && pos <= m.to);
            if (hit) view.dom.dispatchEvent(new CustomEvent("compliance-pick", { detail: { id: hit.id }, bubbles: true }));
            return false;
          },
        },
      }),
    ];
  },
});

function endOfLastText(doc: PMNode): number {
  let end = doc.content.size;
  doc.descendants((n, pos) => { if (n.isTextblock) end = pos + n.nodeSize - 1; });
  return end;
}

/**
 * The editor's text as the checker sees it: one paragraph per text block (joined by blank lines), with the document
 * position of every character (-1 for the separators). Mentions and page links read as their labels.
 */
export function docText(doc: PMNode): { text: string; pos: number[] } {
  let text = "";
  const pos: number[] = [];
  doc.descendants((node, at) => {
    if (!node.isTextblock) return true;
    if (text) { text += "\n\n"; pos.push(-1, -1); }
    node.forEach((child, offset) => {
      const p = at + 1 + offset;
      if (child.isText) {
        const s = child.text ?? "";
        for (let i = 0; i < s.length; i++) { text += s[i]; pos.push(p + i); }
      } else if (child.type.name === "hardBreak") {
        text += "\n"; pos.push(p);
      } else {
        const label = String(child.attrs?.label ?? child.textContent ?? "");
        for (let i = 0; i < label.length; i++) { text += label[i]; pos.push(p); }
      }
    });
    return false;
  });
  return { text, pos };
}

/** A span of the checked text → document positions now: in place if the words are still there, else the nearest copy. */
export function spanToRange(now: { text: string; pos: number[] }, span: { start: number; end: number; text: string }): { from: number; to: number } | null {
  let start = -1;
  if (now.text.slice(span.start, span.end) === span.text) start = span.start;
  else if (span.text) {
    let best = -1, dist = Infinity, i = now.text.indexOf(span.text);
    while (i >= 0) { const d = Math.abs(i - span.start); if (d < dist) { dist = d; best = i; } i = now.text.indexOf(span.text, i + 1); }
    start = best;
  }
  if (start < 0) return null;
  const end = start + span.text.length;
  const a = now.pos.slice(start, end).filter((p) => p >= 0);
  if (!a.length) return null;
  return { from: a[0], to: a[a.length - 1] + 1 };
}

/** Editor-body classes for the marks (arbitrary variants, no global CSS). */
export const COMPLIANCE_CLASSES = [
  "[&_.cmp-flag]:underline [&_.cmp-flag]:decoration-wavy [&_.cmp-flag]:decoration-[1.5px] [&_.cmp-flag]:underline-offset-[5px] [&_.cmp-flag]:cursor-pointer [&_.cmp-flag]:[text-decoration-skip-ink:none]",
  "[&_.cmp-warn]:decoration-warn [&_.cmp-danger]:decoration-danger [&_.cmp-muted]:decoration-muted/60 [&_.cmp-approx]:decoration-dotted",
  "[&_.cmp-active.cmp-warn]:bg-warn-tint [&_.cmp-active.cmp-danger]:bg-danger-tint [&_.cmp-active]:rounded-[2px]",
  "[&_.cmp-strike]:line-through [&_.cmp-strike]:decoration-danger [&_.cmp-strike]:text-muted",
  "[&_.cmp-insert]:rounded-[2px] [&_.cmp-insert]:bg-accent-tint [&_.cmp-insert]:text-accent [&_.cmp-insert-block]:mt-2 [&_.cmp-insert-block]:block [&_.cmp-insert-block]:px-1",
].join(" ");
