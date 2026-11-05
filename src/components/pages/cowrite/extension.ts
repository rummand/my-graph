/**
 * The co-writing plugin for the page editor. It holds the assistant's pending edit (one range of whole blocks),
 * moves it along with the person's own edits, highlights it as a pending change, draws the assistant's caret at its
 * last edit while it writes, and keeps the person's typing out of the range only while the assistant is writing.
 */
import { Extension, type Editor } from "@tiptap/react";
import { Plugin, PluginKey, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { caretPos, mapEdit, touchesRange, type PendingEdit } from "@/lib/wiki/cowrite/pending";

export type CowriteState = { edit: PendingEdit | null; streaming: boolean; touched: boolean };
type Meta = { edit: PendingEdit | null; streaming: boolean };

export const cowriteKey = new PluginKey<CowriteState>("wikiCowrite");

const EMPTY: CowriteState = { edit: null, streaming: false, touched: false };

export function getCowrite(state: EditorState): CowriteState {
  return cowriteKey.getState(state) ?? EMPTY;
}

/** Mark a transaction as the assistant's own (not the person's typing, not in their undo history). */
export function asAssistant(tr: Transaction, meta: Meta): Transaction {
  return tr.setMeta(cowriteKey, meta).setMeta("addToHistory", false);
}

/** True for transactions made by co-writing itself (renders, undo, accept). */
export const isCowriteTr = (tr: Transaction) => !!tr.getMeta(cowriteKey);

/** Forget any pending draft without touching the text (e.g. after loading someone else's version). */
export function clearCowrite(editor: Editor) {
  if (!getCowrite(editor.state).edit) return;
  editor.view.dispatch(asAssistant(editor.state.tr, { edit: null, streaming: false }));
}

export const Cowrite = Extension.create({
  name: "wikiCowrite",
  addProseMirrorPlugins() {
    return [
      new Plugin<CowriteState>({
        key: cowriteKey,
        state: {
          init: () => EMPTY,
          apply(tr, prev) {
            const meta = tr.getMeta(cowriteKey) as Meta | undefined;
            if (meta) {
              const same = !!meta.edit && prev.edit?.id === meta.edit.id;
              return { edit: meta.edit, streaming: meta.streaming, touched: same ? prev.touched : false };
            }
            if (!tr.docChanged || !prev.edit) return prev;
            const touched = prev.touched || touchesRange(tr.steps, prev.edit.from, prev.edit.to);
            return { ...prev, edit: mapEdit(prev.edit, tr.mapping), touched };
          },
        },
        // While it writes, the highlighted range is the assistant's; everywhere else stays the person's.
        filterTransaction(tr, state) {
          const s = cowriteKey.getState(state);
          if (!s?.streaming || !s.edit || !tr.docChanged || tr.getMeta(cowriteKey)) return true;
          return !touchesRange(tr.steps, s.edit.from, s.edit.to);
        },
        props: {
          decorations(state) {
            const s = cowriteKey.getState(state);
            if (!s?.edit) return null;
            const { from } = s.edit;
            const to = Math.min(s.edit.to, state.doc.content.size);
            const decos: Decoration[] = [];
            if (to > from) {
              decos.push(Decoration.inline(from, to, { class: "cowrite-pending" }));
              state.doc.nodesBetween(from, to, (node, pos) => {
                if (pos >= from && pos + node.nodeSize <= to) decos.push(Decoration.node(pos, pos + node.nodeSize, { class: "cowrite-block" }));
                return false;
              });
            }
            if (s.streaming) {
              const at = caretPos(state.doc, { ...s.edit, to }) ?? Math.min(from, state.doc.content.size);
              decos.push(Decoration.widget(at, () => {
                const el = document.createElement("span");
                el.className = "cowrite-caret";
                el.setAttribute("aria-hidden", "true");
                // The caret's name tag follows the page language (<html lang> is set from the reader's setting).
                el.dataset.label = document.documentElement.lang === "da" ? "Assistent" : "Assistant";
                return el;
              }, { side: 1, key: "cowrite-caret", ignoreSelection: true }));
            }
            return DecorationSet.create(state.doc, decos);
          },
        },
      }),
    ];
  },
});

/** Editor-body classes for the pending highlight and the assistant's caret (arbitrary variants, no global CSS). */
export const COWRITE_CLASSES = [
  "[&_.cowrite-pending]:bg-accent-tint [&_.cowrite-pending]:[box-decoration-break:clone] [&_.cowrite-pending]:rounded-[2px]",
  "[&_.cowrite-block]:relative [&_.cowrite-block]:before:absolute [&_.cowrite-block]:before:-left-4 [&_.cowrite-block]:before:inset-y-0 [&_.cowrite-block]:before:w-0.5 [&_.cowrite-block]:before:rounded-full [&_.cowrite-block]:before:bg-accent [&_.cowrite-block]:before:content-['']",
  "[&_.cowrite-caret]:relative [&_.cowrite-caret]:ml-px [&_.cowrite-caret]:inline-block [&_.cowrite-caret]:h-[1.15em] [&_.cowrite-caret]:w-[2px] [&_.cowrite-caret]:rounded-full [&_.cowrite-caret]:bg-accent [&_.cowrite-caret]:align-[-0.2em]",
  "[&_.cowrite-caret]:after:absolute [&_.cowrite-caret]:after:bottom-full [&_.cowrite-caret]:after:left-0 [&_.cowrite-caret]:after:mb-0.5 [&_.cowrite-caret]:after:whitespace-nowrap [&_.cowrite-caret]:after:rounded-[3px] [&_.cowrite-caret]:after:bg-accent [&_.cowrite-caret]:after:px-1 [&_.cowrite-caret]:after:py-px [&_.cowrite-caret]:after:font-sans [&_.cowrite-caret]:after:text-[11px] [&_.cowrite-caret]:after:font-medium [&_.cowrite-caret]:after:leading-tight [&_.cowrite-caret]:after:text-accent-fg [&_.cowrite-caret]:after:content-[attr(data-label)]",
].join(" ");
