"use client";
/**
 * TipTap blocks for the profile editor beyond the wiki's: toggles, tables (prosemirror-tables via @tiptap/pm), images
 * from the library, fact chips, and the live highlights plugin. The stored shape is checked by src/lib/profile/doc.
 */
import { Extension, Node, callOrReturn, getExtensionField, mergeAttributes, NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { addColumnAfter, addRowAfter, deleteColumn, deleteRow, deleteTable, goToNextCell, tableEditing } from "@tiptap/pm/tables";
import { ChevronRight } from "lucide-react";
import { clsx } from "clsx";
import { typeColor, typeTint } from "@/components/mention/colors";

declare module "@tiptap/core" {
  interface NodeConfig<Options, Storage> {
    /** prosemirror-tables' role for this node (table, row, cell, header_cell). */
    tableRole?: string | ((this: { name: string; options: Options; storage: Storage }) => string);
  }
  interface Commands<ReturnType> {
    profileTable: {
      insertProfileTable: (rows?: number, cols?: number) => ReturnType;
      addProfileRow: () => ReturnType;
      addProfileColumn: () => ReturnType;
      deleteProfileRow: () => ReturnType;
      deleteProfileColumn: () => ReturnType;
      deleteProfileTable: () => ReturnType;
    };
    profileToggle: { insertToggle: () => ReturnType };
    libraryImage: { insertLibraryImage: (attrs: { sourceId: string; alt: string }) => ReturnType };
  }
}

/* ── Toggle ────────────────────────────────────────────────────────────────────────────────────────────── */

function ToggleView({ node, updateAttributes, editor }: NodeViewProps) {
  const open = node.attrs.open === true;
  return (
    <NodeViewWrapper className="my-3 rounded-md" data-type="toggle">
      <div className="flex items-start gap-1.5">
        <button type="button" contentEditable={false} aria-expanded={open} aria-label={open ? "Collapse" : "Expand"}
          onClick={() => updateAttributes({ open: !open })}
          className="mt-[0.35em] grid size-6 shrink-0 place-items-center rounded text-muted hover:bg-surface-2 hover:text-fg">
          <ChevronRight aria-hidden className={clsx("size-4 transition-transform duration-150", open && "rotate-90")} />
        </button>
        <input value={String(node.attrs.summary ?? "")} readOnly={!editor.isEditable} placeholder="Toggle"
          onChange={(e) => updateAttributes({ summary: e.target.value })}
          className="min-w-0 flex-1 bg-transparent font-sans text-[15px] font-medium outline-none placeholder:text-muted" />
      </div>
      <NodeViewContent className={clsx("pl-7", !open && "hidden")} />
    </NodeViewWrapper>
  );
}

export const Toggle = Node.create({
  name: "toggle",
  group: "block",
  content: "block+",
  defining: true,
  addAttributes() {
    return {
      summary: { default: "", parseHTML: (el) => el.querySelector("summary")?.textContent ?? "" },
      open: { default: true, parseHTML: (el) => el.hasAttribute("open") },
    };
  },
  parseHTML() { return [{ tag: "details" }]; },
  renderHTML({ node }) { return ["details", node.attrs.open ? { open: "" } : {}, ["summary", {}, String(node.attrs.summary ?? "")], ["div", 0]]; },
  addNodeView() { return ReactNodeViewRenderer(ToggleView); },
  addCommands() {
    return {
      insertToggle: () => ({ commands }) => commands.insertContent({ type: "toggle", attrs: { summary: "", open: true }, content: [{ type: "paragraph" }] }),
    };
  },
});

/* ── Tables ────────────────────────────────────────────────────────────────────────────────────────────── */

/** Passes `tableRole` into the ProseMirror schema, which prosemirror-tables reads. */
export const TableRoles = Extension.create({
  name: "profileTableRoles",
  extendNodeSchema(extension) {
    const ctx = { name: extension.name, options: extension.options, storage: extension.storage };
    return { tableRole: callOrReturn(getExtensionField(extension, "tableRole", ctx)) };
  },
});

const cellAttrs = () => ({ colspan: { default: 1 }, rowspan: { default: 1 }, colwidth: { default: null } });

export const TableCell = Node.create({
  name: "tableCell", content: "block+", tableRole: "cell", isolating: true,
  addAttributes: cellAttrs,
  parseHTML() { return [{ tag: "td" }]; },
  renderHTML({ HTMLAttributes }) { return ["td", mergeAttributes(HTMLAttributes, { class: "border border-line px-2 py-1 align-top" }), 0]; },
});

export const TableHeader = Node.create({
  name: "tableHeader", content: "block+", tableRole: "header_cell", isolating: true,
  addAttributes: cellAttrs,
  parseHTML() { return [{ tag: "th" }]; },
  renderHTML({ HTMLAttributes }) { return ["th", mergeAttributes(HTMLAttributes, { class: "border border-line bg-surface-2 px-2 py-1 text-left align-top font-sans text-sm font-semibold" }), 0]; },
});

export const TableRow = Node.create({
  name: "tableRow", content: "(tableCell | tableHeader)*", tableRole: "row",
  parseHTML() { return [{ tag: "tr" }]; },
  renderHTML() { return ["tr", 0]; },
});

export const Table = Node.create({
  name: "table", group: "block", content: "tableRow+", tableRole: "table", isolating: true,
  parseHTML() { return [{ tag: "table" }]; },
  renderHTML() { return ["div", { class: "my-4 overflow-x-auto" }, ["table", { class: "w-full border-collapse font-sans text-[15px] [&_p]:my-0" }, ["tbody", 0]]]; },
  addProseMirrorPlugins() { return [tableEditing()]; },
  addKeyboardShortcuts() {
    return {
      Tab: () => goToNextCell(1)(this.editor.state, this.editor.view.dispatch),
      "Shift-Tab": () => goToNextCell(-1)(this.editor.state, this.editor.view.dispatch),
    };
  },
  addCommands() {
    const cell = (type: "tableCell" | "tableHeader") => ({ type, content: [{ type: "paragraph" }] });
    return {
      insertProfileTable: (rows = 3, cols = 2) => ({ commands }) => commands.insertContent({
        type: "table",
        content: Array.from({ length: rows }, (_, r) => ({ type: "tableRow", content: Array.from({ length: cols }, () => cell(r === 0 ? "tableHeader" : "tableCell")) })),
      }),
      addProfileRow: () => ({ state, dispatch }) => addRowAfter(state, dispatch),
      addProfileColumn: () => ({ state, dispatch }) => addColumnAfter(state, dispatch),
      deleteProfileRow: () => ({ state, dispatch }) => deleteRow(state, dispatch),
      deleteProfileColumn: () => ({ state, dispatch }) => deleteColumn(state, dispatch),
      deleteProfileTable: () => ({ state, dispatch }) => deleteTable(state, dispatch),
    };
  },
});

/* ── Library images ────────────────────────────────────────────────────────────────────────────────────── */

export const LibraryImage = Node.create({
  name: "libraryImage", group: "block", atom: true, draggable: true,
  addAttributes() { return { sourceId: { default: null }, alt: { default: "" } }; },
  parseHTML() { return [{ tag: "img[data-source-id]", getAttrs: (el) => ({ sourceId: (el as HTMLElement).getAttribute("data-source-id"), alt: (el as HTMLElement).getAttribute("alt") ?? "" }) }]; },
  renderHTML({ node }) {
    return ["figure", { class: "my-4" }, ["img", {
      "data-source-id": String(node.attrs.sourceId ?? ""), alt: String(node.attrs.alt ?? ""), loading: "lazy",
      src: `/api/files/${node.attrs.sourceId}`, class: "max-h-[420px] max-w-full rounded-lg bg-surface-2 object-contain",
    }], ["figcaption", { class: "mt-1 font-sans text-xs text-muted" }, String(node.attrs.alt ?? "")]];
  },
  addCommands() {
    return { insertLibraryImage: (attrs) => ({ commands }) => commands.insertContent([{ type: "libraryImage", attrs }, { type: "paragraph" }]) };
  },
});

/* ── Fact chips ────────────────────────────────────────────────────────────────────────────────────────── */

export const FactRef = Node.create({
  name: "factRef", group: "inline", inline: true, atom: true, selectable: true,
  addAttributes() {
    return { edgeId: { default: null }, otherId: { default: null }, otherLabel: { default: "" }, otherType: { default: "thing" }, phrase: { default: "" } };
  },
  parseHTML() { return [{ tag: "span[data-fact-other]" }]; },
  renderHTML({ node }) {
    const type = String(node.attrs.otherType ?? "thing");
    return ["span", {
      "data-fact-other": String(node.attrs.otherId ?? ""), "data-type": "factRef",
      class: "inline-flex items-baseline gap-1 rounded-full px-2 py-px font-sans text-[0.85em]",
      style: `background:${typeTint(type)}`,
      title: `${node.attrs.phrase}: ${node.attrs.otherLabel}`,
    }, ["span", { class: "text-muted" }, `${node.attrs.phrase}:`], ["span", { class: "font-medium", style: `color:${typeColor(type)}` }, String(node.attrs.otherLabel ?? "")]];
  },
  renderText({ node }) { return `${node.attrs.phrase}: ${node.attrs.otherLabel}`; },
});

/* ── Live highlights ───────────────────────────────────────────────────────────────────────────────────── */

export type HighlightTerm = { text: string; tone: "existing" | "new" | "newKind"; tag: string };
export const highlightKey = new PluginKey<DecorationSet>("profileLiveHighlights");

const TONE: Record<HighlightTerm["tone"], string> = {
  existing: "rounded-[3px] underline decoration-accent decoration-2 underline-offset-[3px]",
  new: "rounded-[3px] bg-[var(--warn-tint)]",
  newKind: "rounded-[3px] bg-[var(--inferred-tint)]",
};

function decorate(state: EditorState, terms: HighlightTerm[]): DecorationSet {
  if (!terms.length) return DecorationSet.empty;
  const decos: Decoration[] = [];
  state.doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    const lower = node.text.toLowerCase();
    for (const t of terms) {
      const needle = t.text.toLowerCase();
      if (needle.length < 2) continue;
      let i = lower.indexOf(needle);
      while (i >= 0) {
        const before = lower[i - 1], after = lower[i + needle.length];
        if (!(before && /[\p{L}\p{N}]/u.test(before)) && !(after && /[\p{L}\p{N}]/u.test(after))) {
          decos.push(Decoration.inline(pos + i, pos + i + needle.length, { class: TONE[t.tone], title: t.tag }));
        }
        i = lower.indexOf(needle, i + needle.length);
      }
    }
  });
  return DecorationSet.create(state.doc, decos);
}

/** Proposals the highlighter found, marked in the text. Set with `tr.setMeta(highlightKey, terms)`. */
export const LiveHighlights = Extension.create({
  name: "profileLiveHighlights",
  addProseMirrorPlugins() {
    let terms: HighlightTerm[] = [];
    return [new Plugin<DecorationSet>({
      key: highlightKey,
      state: {
        init: () => DecorationSet.empty,
        apply: (tr, old, _oldState, newState) => {
          const next = tr.getMeta(highlightKey) as HighlightTerm[] | undefined;
          if (next) { terms = next; return decorate(newState, terms); }
          return tr.docChanged ? decorate(newState, terms) : old;
        },
      },
      props: { decorations: (state) => highlightKey.getState(state) },
    })];
  },
});
