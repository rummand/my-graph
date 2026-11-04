"use client";
/**
 * @mentions for TipTap editors: the same typeahead and markup as plain textareas.
 *
 *   useEditor({ extensions: [StarterKit, GraphMention] })
 *
 * The node renders as a chip (data-node-id, data-node-type) and serialises to text as `@[Label](node:id)`, the
 * shared mention markup. "Create new …" is left to the host (pass `onCreate` to `graphMention`).
 */
import Mention, { type MentionNodeAttrs } from "@tiptap/extension-mention";
import { ReactRenderer } from "@tiptap/react";
import { PluginKey } from "@tiptap/pm/state";
import type { SuggestionKeyDownProps, SuggestionProps } from "@tiptap/suggestion";
import { forwardRef, useImperativeHandle, useState } from "react";
import { fetchMentionables } from "./api";
import { mentionMarkup } from "@/lib/mentions/markup";
import { MentionMenu } from "./mention-menu";
import type { TypeaheadItem } from "./use-mention-typeahead";
import { typeColor, typeTint } from "./colors";

type MenuHandle = { onKeyDown: (p: SuggestionKeyDownProps) => boolean };
type MenuProps = { items: TypeaheadItem[]; query: string; command: (item: TypeaheadItem) => void };

const SuggestionMenu = forwardRef<MenuHandle, MenuProps>(function SuggestionMenu({ items, query, command }, ref) {
  const [active, setActive] = useState(0);
  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }) => {
      if (!items.length) return false;
      if (event.key === "ArrowDown") { setActive((a) => (a + 1) % items.length); return true; }
      if (event.key === "ArrowUp") { setActive((a) => (a - 1 + items.length) % items.length); return true; }
      if (event.key === "Enter" || event.key === "Tab") { command(items[Math.min(active, items.length - 1)]); return true; }
      return false;
    },
  }), [items, active, command]);
  return <MentionMenu id="tiptap-mention-menu" items={items} active={Math.min(active, Math.max(items.length - 1, 0))} onPick={command} onHover={setActive} loading={false} query={query} />;
});

export function graphMention(opts: { onCreate?: (label: string) => void } = {}) {
  return Mention.extend({
    addAttributes() {
      return {
        ...this.parent?.(),
        nodeType: { default: null, parseHTML: (el: HTMLElement) => el.getAttribute("data-node-type"), renderHTML: (a: Record<string, unknown>) => (a.nodeType ? { "data-node-type": a.nodeType } : {}) },
      };
    },
  }).configure({
    renderText: ({ node }) => mentionMarkup(String(node.attrs.label ?? ""), String(node.attrs.id ?? "")),
    renderHTML: ({ node }) => ["span", {
      "data-node-id": String(node.attrs.id ?? ""), class: "rounded-[4px] px-0.5 font-medium underline decoration-1 underline-offset-[3px]",
      style: `background:${typeTint(node.attrs.nodeType as string)};text-decoration-color:${typeColor(node.attrs.nodeType as string)}`,
    }, String(node.attrs.label ?? "")],
    suggestion: {
      char: "@",
      pluginKey: new PluginKey("graphMention"),
      items: async ({ query }): Promise<TypeaheadItem[]> => {
        const found: TypeaheadItem[] = (await fetchMentionables(query)).map((m) => ({ kind: "node", m }));
        if (opts.onCreate && query.trim().length >= 2 && !found.some((f) => f.kind === "node" && f.m.label.toLowerCase() === query.trim().toLowerCase())) found.push({ kind: "create", label: query.trim() });
        return found;
      },
      command: ({ editor, range, props }) => {
        const item = props as unknown as TypeaheadItem;
        if (item.kind === "create") {
          editor.chain().focus().insertContentAt(range, `${item.label} `).run();
          opts.onCreate?.(item.label);
          return;
        }
        editor.chain().focus().insertContentAt(range, [
          { type: "mention", attrs: { id: item.m.nodeId, label: item.m.label, nodeType: item.m.type } },
          { type: "text", text: " " },
        ]).run();
      },
      render: () => {
        let r: ReactRenderer<MenuHandle, MenuProps> | null = null;
        let box: HTMLDivElement | null = null;
        const place = (p: SuggestionProps<TypeaheadItem, MentionNodeAttrs>) => {
          const rect = p.clientRect?.();
          if (!box || !rect) return;
          box.style.left = `${Math.min(rect.left, window.innerWidth - 300)}px`;
          box.style.top = `${rect.bottom + 6}px`;
        };
        return {
          onStart: (p) => {
            box = document.createElement("div");
            box.style.position = "fixed";
            box.style.zIndex = "60";
            document.body.appendChild(box);
            r = new ReactRenderer(SuggestionMenu, { editor: p.editor, props: { items: p.items, query: p.query, command: (i: TypeaheadItem) => p.command(i as never) } });
            box.appendChild(r.element);
            place(p);
          },
          onUpdate: (p) => { r?.updateProps({ items: p.items, query: p.query, command: (i: TypeaheadItem) => p.command(i as never) }); place(p); },
          onKeyDown: (p) => {
            if (p.event.key === "Escape") { box?.remove(); box = null; return true; }
            return r?.ref?.onKeyDown(p) ?? false;
          },
          onExit: () => { r?.destroy(); r = null; box?.remove(); box = null; },
        };
      },
    },
  });
}

export const GraphMention = graphMention();
