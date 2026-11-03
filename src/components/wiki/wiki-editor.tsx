"use client";
/**
 * The page editor: TipTap with headings, lists, checklists, quotes, code and links, plus two suggestion triggers:
 *   @   mention a person, place, event or topic from the graph (GET /api/nodes?q=)
 *   [[  link to another wiki page (GET /api/wiki?q=), or create one
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import Mention, { type MentionNodeAttrs } from "@tiptap/extension-mention";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { PluginKey } from "@tiptap/pm/state";
import type { SuggestionKeyDownProps, SuggestionProps } from "@tiptap/suggestion";
import { clsx } from "clsx";
import {
  Bold, Code, FileText, Heading2, Heading3, Italic, Link2, List, ListChecks, ListOrdered, Plus, Quote, Redo2, SquareCode, Strikethrough, Undo2,
} from "lucide-react";
import type { Doc } from "@/lib/wiki/doc";
import type { Visibility } from "@/lib/wiki/labels";
import { MENTION_CLASS, PAGE_LINK_CLASS, PROSE } from "./prose";

/* ── Suggestion data ───────────────────────────────────────────────────────────────────────────────────── */

type NodeItem = { kind: "node"; id: string; label: string; type: string };
type PageItem = { kind: "page"; id: string; label: string; slug: string } | { kind: "create"; label: string };
type Item = NodeItem | PageItem;

const TYPE_LABEL: Record<string, string> = { person: "Person", place: "Place", event: "Event", topic: "Topic", document: "Document", source: "Source" };

async function fetchNodes(q: string): Promise<NodeItem[]> {
  if (!q.trim()) return [];
  try {
    const res = await fetch(`/api/nodes?q=${encodeURIComponent(q)}&limit=8`, { headers: { accept: "application/json" } });
    if (!res.ok) return [];
    const data = (await res.json()) as { nodes?: { id: string; type: string; label: string }[] };
    return (data.nodes ?? []).filter((n) => n.type !== "source").slice(0, 8).map((n) => ({ kind: "node", id: n.id, label: n.label, type: n.type }));
  } catch {
    return [];
  }
}

async function fetchPages(q: string, excludeId: string): Promise<PageItem[]> {
  let pages: PageItem[] = [];
  try {
    const res = await fetch(`/api/wiki?limit=8${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ""}`, { headers: { accept: "application/json" } });
    if (res.ok) {
      const data = (await res.json()) as { pages?: { id: string; slug: string; title: string }[] };
      pages = (data.pages ?? []).filter((p) => p.id !== excludeId).map((p) => ({ kind: "page", id: p.id, label: p.title, slug: p.slug }));
    }
  } catch {
    /* no suggestions */
  }
  const title = q.replace(/\]+$/, "").trim();
  if (title && !pages.some((p) => p.label.toLowerCase() === title.toLowerCase())) pages.push({ kind: "create", label: title });
  return pages;
}

/* ── Suggestion popup ──────────────────────────────────────────────────────────────────────────────────── */

type Popup = { trigger: "@" | "[["; items: Item[]; query: string; rect: DOMRect | null; select: (item: Item) => void };

function SuggestionList({ popup, index, onHover, listId }: { popup: Popup; index: number; onHover: (i: number) => void; listId: string }) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useEffect(() => {
    if (!popup.rect) return;
    const width = Math.min(320, window.innerWidth - 16);
    const left = Math.max(8, Math.min(popup.rect.left, window.innerWidth - width - 8));
    const below = popup.rect.bottom + 6;
    const top = below + 260 > window.innerHeight ? Math.max(8, popup.rect.top - 266) : below;
    setPos({ top, left });
  }, [popup.rect]);

  const empty = popup.trigger === "@"
    ? popup.query.trim() ? `Nothing in the graph matches “${popup.query}”.` : "Type a name to mention someone or something."
    : "No pages yet.";

  return (
    <div role="listbox" id={listId} aria-label={popup.trigger === "@" ? "Mention from the graph" : "Link to a page"}
      className="fixed z-50 max-h-64 w-[min(320px,calc(100vw-16px))] overflow-y-auto rounded-lg border border-line bg-surface p-1 shadow-lg"
      style={pos ? { top: pos.top, left: pos.left } : { visibility: "hidden" }}>
      {popup.items.length === 0 && <p className="px-3 py-2 text-sm text-muted">{empty}</p>}
      {popup.items.map((item, i) => (
        <button key={item.kind === "create" ? "create" : item.id} type="button" role="option" aria-selected={i === index} id={`${listId}-${i}`}
          onMouseDown={(e) => { e.preventDefault(); popup.select(item); }} onMouseEnter={() => onHover(i)}
          className={clsx("flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm", i === index ? "bg-accent-tint text-accent" : "hover:bg-surface-2")}>
          {item.kind === "node" && (
            <>
              <span className="size-2 shrink-0 rounded-full" style={{ background: `var(--t-${item.type}, var(--muted))` }} aria-hidden />
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              <span className="shrink-0 text-xs text-muted">{TYPE_LABEL[item.type] ?? item.type}</span>
            </>
          )}
          {item.kind === "page" && (<><FileText aria-hidden className="size-4 shrink-0 text-muted" /><span className="min-w-0 flex-1 truncate">{item.label}</span></>)}
          {item.kind === "create" && (<><Plus aria-hidden className="size-4 shrink-0" /><span className="min-w-0 flex-1 truncate">Create page “{item.label}”</span></>)}
        </button>
      ))}
    </div>
  );
}

/* ── Toolbar ───────────────────────────────────────────────────────────────────────────────────────────── */

function ToolButton({ label, active, disabled, onClick, children }: { label: string; active?: boolean; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} aria-pressed={active} disabled={disabled}
      onMouseDown={(e) => e.preventDefault()} onClick={onClick}
      className={clsx("inline-flex size-9 items-center justify-center rounded-md disabled:opacity-40",
        active ? "bg-accent-tint text-accent" : "text-muted hover:bg-surface-2 hover:text-fg")}>
      {children}
    </button>
  );
}

function Toolbar({ editor }: { editor: Editor }) {
  // Re-render on selection/content changes so active states stay correct.
  const [, force] = useState(0);
  useEffect(() => {
    const f = () => force((n) => n + 1);
    editor.on("transaction", f);
    return () => { editor.off("transaction", f); };
  }, [editor]);

  const c = () => editor.chain().focus();
  const setLink = () => {
    const prev = editor.getAttributes("link").href as string | undefined;
    const url = window.prompt("Link address (leave empty to remove the link)", prev ?? "https://");
    if (url === null) return;
    if (!url.trim() || url.trim() === "https://") { c().extendMarkRange("link").unsetLink().run(); return; }
    const href = /^(https?:|mailto:|tel:|\/)/i.test(url.trim()) ? url.trim() : `https://${url.trim()}`;
    c().extendMarkRange("link").setLink({ href }).run();
  };
  const icon = "size-4";
  return (
    <div role="toolbar" aria-label="Formatting" className="sticky top-0 z-10 -mx-1 flex flex-wrap items-center gap-0.5 border-b border-line bg-surface/95 px-1 py-1 backdrop-blur">
      <ToolButton label="Heading" active={editor.isActive("heading", { level: 2 })} onClick={() => c().toggleHeading({ level: 2 }).run()}><Heading2 className={icon} /></ToolButton>
      <ToolButton label="Subheading" active={editor.isActive("heading", { level: 3 })} onClick={() => c().toggleHeading({ level: 3 }).run()}><Heading3 className={icon} /></ToolButton>
      <span className="mx-1 h-5 w-px bg-line" aria-hidden />
      <ToolButton label="Bold" active={editor.isActive("bold")} onClick={() => c().toggleBold().run()}><Bold className={icon} /></ToolButton>
      <ToolButton label="Italic" active={editor.isActive("italic")} onClick={() => c().toggleItalic().run()}><Italic className={icon} /></ToolButton>
      <ToolButton label="Strikethrough" active={editor.isActive("strike")} onClick={() => c().toggleStrike().run()}><Strikethrough className={icon} /></ToolButton>
      <ToolButton label="Inline code" active={editor.isActive("code")} onClick={() => c().toggleCode().run()}><Code className={icon} /></ToolButton>
      <ToolButton label="Link" active={editor.isActive("link")} onClick={setLink}><Link2 className={icon} /></ToolButton>
      <span className="mx-1 h-5 w-px bg-line" aria-hidden />
      <ToolButton label="Bulleted list" active={editor.isActive("bulletList")} onClick={() => c().toggleBulletList().run()}><List className={icon} /></ToolButton>
      <ToolButton label="Numbered list" active={editor.isActive("orderedList")} onClick={() => c().toggleOrderedList().run()}><ListOrdered className={icon} /></ToolButton>
      <ToolButton label="Checklist" active={editor.isActive("taskList")} onClick={() => c().toggleTaskList().run()}><ListChecks className={icon} /></ToolButton>
      <ToolButton label="Quote" active={editor.isActive("blockquote")} onClick={() => c().toggleBlockquote().run()}><Quote className={icon} /></ToolButton>
      <ToolButton label="Code block" active={editor.isActive("codeBlock")} onClick={() => c().toggleCodeBlock().run()}><SquareCode className={icon} /></ToolButton>
      <span className="mx-1 h-5 w-px bg-line" aria-hidden />
      <ToolButton label="Undo" disabled={!editor.can().undo()} onClick={() => c().undo().run()}><Undo2 className={icon} /></ToolButton>
      <ToolButton label="Redo" disabled={!editor.can().redo()} onClick={() => c().redo().run()}><Redo2 className={icon} /></ToolButton>
    </div>
  );
}

/* ── Editor ────────────────────────────────────────────────────────────────────────────────────────────── */

export type WikiEditorProps = {
  pageId: string;
  pageVisibility: Visibility;
  initialContent: Doc;
  onChange: (doc: Doc) => void;
  onReady?: (editor: Editor) => void;
  labelledBy?: string;
};

export function WikiEditor({ pageId, pageVisibility, initialContent, onChange, onReady, labelledBy }: WikiEditorProps) {
  const [popup, setPopup] = useState<Popup | null>(null);
  const [index, setIndex] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const popupRef = useRef<Popup | null>(null);
  const indexRef = useRef(0);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const visibilityRef = useRef(pageVisibility);
  visibilityRef.current = pageVisibility;
  const listId = `wiki-suggest-${pageId}`;

  const show = (p: Popup | null) => {
    popupRef.current = p;
    setPopup(p);
    if (!p || indexRef.current >= p.items.length) { indexRef.current = 0; setIndex(0); }
  };
  const move = (i: number) => { indexRef.current = i; setIndex(i); };

  /** Lifecycle shared by both triggers: mirror suggestion state into React and handle the keyboard. */
  const renderer = (trigger: "@" | "[[") => () => ({
    onStart: (props: SuggestionProps<Item, MentionNodeAttrs>) => {
      indexRef.current = 0; setIndex(0);
      show({ trigger, items: props.items, query: props.query, rect: props.clientRect?.() ?? null, select: (item) => props.command(item as never) });
    },
    onUpdate: (props: SuggestionProps<Item, MentionNodeAttrs>) => {
      show({ trigger, items: props.items, query: props.query, rect: props.clientRect?.() ?? null, select: (item) => props.command(item as never) });
    },
    onKeyDown: ({ event }: SuggestionKeyDownProps) => {
      const p = popupRef.current;
      if (!p) return false;
      if (event.key === "Escape") { show(null); return true; }
      if (!p.items.length) return false;
      if (event.key === "ArrowDown") { move((indexRef.current + 1) % p.items.length); return true; }
      if (event.key === "ArrowUp") { move((indexRef.current - 1 + p.items.length) % p.items.length); return true; }
      if (event.key === "Enter" || event.key === "Tab") { p.select(p.items[indexRef.current]); return true; }
      return false;
    },
    onExit: () => show(null),
  });

  const editor = useEditor({
    immediatelyRender: false,
    content: initialContent,
    extensions: [
      StarterKit.configure({
        heading: { levels: [2, 3] },
        link: { openOnClick: false, autolink: true, defaultProtocol: "https", protocols: ["http", "https", "mailto", "tel"], HTMLAttributes: { rel: "noopener noreferrer nofollow" } },
      }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Placeholder.configure({
        placeholder: ({ node }) => node.type.name === "heading" ? "Heading" : "Write here. Type @ to mention someone, [[ to link a page.",
        emptyEditorClass: "is-editor-empty",
      }),
      Mention.extend({
        addAttributes() {
          return {
            ...this.parent?.(),
            nodeType: { default: null, parseHTML: (el: HTMLElement) => el.getAttribute("data-node-type"), renderHTML: (a: Record<string, unknown>) => (a.nodeType ? { "data-node-type": a.nodeType } : {}) },
          };
        },
      }).configure({
        HTMLAttributes: { class: MENTION_CLASS },
        renderText: ({ node }) => `@${node.attrs.label ?? ""}`,
        renderHTML: ({ options, node }) => ["span", options.HTMLAttributes, `@${node.attrs.label ?? ""}`],
        suggestion: {
          char: "@",
          allowSpaces: false,
          pluginKey: new PluginKey("wikiMention"),
          items: ({ query }) => fetchNodes(query),
          command: ({ editor, range, props }) => {
            const item = props as unknown as NodeItem;
            editor.chain().focus().insertContentAt(range, [
              { type: "mention", attrs: { id: item.id, label: item.label, nodeType: item.type } },
              { type: "text", text: " " },
            ]).run();
          },
          render: renderer("@"),
        },
      }),
      Mention.extend({
        name: "pageLink",
        addAttributes() {
          return {
            ...this.parent?.(),
            slug: { default: null, parseHTML: (el: HTMLElement) => el.getAttribute("data-slug"), renderHTML: (a: Record<string, unknown>) => (a.slug ? { "data-slug": a.slug } : {}) },
          };
        },
      }).configure({
        HTMLAttributes: { class: PAGE_LINK_CLASS },
        renderText: ({ node }) => `[[${node.attrs.label ?? ""}]]`,
        renderHTML: ({ options, node }) => ["span", options.HTMLAttributes, String(node.attrs.label ?? "")],
        suggestion: {
          char: "[[",
          allowSpaces: true,
          pluginKey: new PluginKey("wikiPageLink"),
          items: ({ query }) => fetchPages(query, pageId),
          command: ({ editor, range, props }) => {
            const item = props as unknown as PageItem;
            const insert = (p: { id: string; label: string; slug: string }) => {
              // Swallow a "]]" the writer typed out of habit.
              const after = editor.state.doc.textBetween(range.to, Math.min(range.to + 2, editor.state.doc.content.size), "");
              const to = after === "]]" ? range.to + 2 : range.to;
              editor.chain().focus().insertContentAt({ from: range.from, to }, [
                { type: "pageLink", attrs: { id: p.id, label: p.label, slug: p.slug } },
                { type: "text", text: " " },
              ]).run();
            };
            if (item.kind === "page") { insert(item); return; }
            void (async () => {
              try {
                const res = await fetch("/api/wiki", {
                  method: "POST", headers: { "content-type": "application/json" },
                  body: JSON.stringify({ title: item.label, visibility: visibilityRef.current }),
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(data.error ?? "Couldn't create the page.");
                insert({ id: data.page.id, label: data.page.title, slug: data.page.slug });
                setNotice(`Created the page “${data.page.title}”. It's empty for now.`);
              } catch (e) {
                setNotice(e instanceof Error ? e.message : "Couldn't create the page.");
              }
            })();
          },
          render: renderer("[["),
        },
      }),
    ],
    editorProps: {
      attributes: {
        class: clsx(PROSE, "min-h-[40vh] py-4 outline-none",
          "[&_p.is-editor-empty:first-child]:before:pointer-events-none [&_p.is-editor-empty:first-child]:before:float-left [&_p.is-editor-empty:first-child]:before:h-0 [&_p.is-editor-empty:first-child]:before:text-muted [&_p.is-editor-empty:first-child]:before:content-[attr(data-placeholder)]"),
        role: "textbox",
        "aria-multiline": "true",
        ...(labelledBy ? { "aria-labelledby": labelledBy } : { "aria-label": "Page text" }),
      },
    },
    onUpdate: ({ editor }) => onChangeRef.current(editor.getJSON() as Doc),
  });

  useEffect(() => {
    if (editor && onReady) onReady(editor);
  }, [editor, onReady]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(t);
  }, [notice]);

  // Point assistive tech at the highlighted suggestion.
  useEffect(() => {
    const dom = editor?.view?.dom;
    if (!dom) return;
    if (popup && popup.items.length) {
      dom.setAttribute("aria-controls", listId);
      dom.setAttribute("aria-activedescendant", `${listId}-${index}`);
    } else {
      dom.removeAttribute("aria-activedescendant");
    }
  }, [editor, popup, index, listId]);

  if (!editor) {
    return <div className="min-h-[40vh] animate-pulse rounded-md bg-surface-2" aria-busy="true"><span className="sr-only">Loading the editor…</span></div>;
  }
  return (
    <div>
      <Toolbar editor={editor} />
      <EditorContent editor={editor} />
      {popup && <SuggestionList popup={popup} index={index} onHover={move} listId={listId} />}
      <p role="status" aria-live="polite" className="text-sm text-muted">{notice}</p>
    </div>
  );
}
