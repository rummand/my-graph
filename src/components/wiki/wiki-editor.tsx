"use client";
/**
 * The page editor: TipTap with headings, lists, checklists, quotes, code and links, plus two suggestion triggers:
 *   @   mention anything in the current graph: the shared @mention typeahead (src/components/mention, GET /api/mentions)
 *   [[  link to another wiki page (GET /api/wiki?q=), or create one
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { EditorContent, mergeAttributes, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import Mention, { type MentionNodeAttrs } from "@tiptap/extension-mention";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { PluginKey } from "@tiptap/pm/state";
import type { SuggestionKeyDownProps, SuggestionProps } from "@tiptap/suggestion";
import { clsx } from "clsx";
import {
  AtSign, Bold, Code, FileText, Heading2, Heading3, Italic, Link2, List, ListChecks, ListOrdered, Plus, Quote, Redo2, Sparkles, SquareCode, Strikethrough, Undo2,
} from "lucide-react";
import { Button } from "@/components/ui";
import { graphMention } from "@/components/mention/tiptap";
import { useT } from "@/lib/i18n/client";
import type { TFn } from "@/lib/i18n/core";
import type { Doc } from "@/lib/wiki/doc";
import type { Visibility } from "@/lib/wiki/labels";
import { CowritePanel, savedDocOf, type AcceptInfo, type AcceptResult } from "./cowrite/cowrite-panel";
import { Cowrite, COWRITE_CLASSES, isCowriteTr } from "./cowrite/extension";
import { mentionChip, PAGE_LINK_CLASS, PROSE } from "./prose";

/* ── Suggestion data ───────────────────────────────────────────────────────────────────────────────────── */

type PageItem = { kind: "page"; id: string; label: string; slug: string } | { kind: "create"; label: string };

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

type Popup = { items: PageItem[]; query: string; rect: DOMRect | null; select: (item: PageItem) => void };

/** The [[ page-link list. (@ uses the shared mention menu.) */
function SuggestionList({ popup, index, onHover, listId }: { popup: Popup; index: number; onHover: (i: number) => void; listId: string }) {
  const t = useT();
  const [pos, setPos] = useState<{ top?: number; bottom?: number; left: number } | null>(null);
  useEffect(() => {
    if (!popup.rect) return;
    const width = Math.min(320, window.innerWidth - 16);
    const left = Math.max(8, Math.min(popup.rect.left - 8, window.innerWidth - width - 8));
    // Open below the caret; if there isn't room, open above it, anchored to the line so a short list stays close.
    const roomBelow = window.innerHeight - popup.rect.bottom;
    setPos(roomBelow < 300 && popup.rect.top > roomBelow
      ? { bottom: window.innerHeight - popup.rect.top + 8, left }
      : { top: popup.rect.bottom + 8, left });
  }, [popup.rect]);


  return (
    <div className="fixed z-50 w-[min(320px,calc(100vw-16px))] rounded-lg bg-surface p-1.5 font-sans shadow-float"
      style={pos ?? { visibility: "hidden" }}>
      <p className="px-2.5 pb-1 pt-1 text-xs text-muted">{t("wiki.editor.pages.title")}</p>
      <div role="listbox" id={listId} aria-label={t("wiki.editor.pages.title")} className="max-h-64 overflow-y-auto">
        {popup.items.length === 0 && <p className="px-2.5 py-2 text-sm text-muted">{t("wiki.editor.pages.empty")}</p>}
        {popup.items.map((item, i) => {
          const on = i === index;
          return (
            <button key={item.kind === "create" ? "create" : item.id} type="button" role="option" aria-selected={on} id={`${listId}-${i}`}
              onMouseDown={(e) => { e.preventDefault(); popup.select(item); }} onMouseEnter={() => onHover(i)}
              className={clsx("flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm", on ? "bg-surface-2 text-fg" : "text-fg")}>
              {item.kind === "page" && (<><FileText aria-hidden className="size-4 shrink-0 text-muted" /><span className="min-w-0 flex-1 truncate">{item.label}</span></>)}
              {item.kind === "create" && (<><Plus aria-hidden className="size-4 shrink-0 text-accent" /><span className="min-w-0 flex-1 truncate">{t("wiki.editor.pages.newCalled")} <span className="font-medium">{item.label}</span></span></>)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ── Toolbar ───────────────────────────────────────────────────────────────────────────────────────────── */

function ToolButton({ label, keys, active, disabled, onClick, children }: { label: string; keys?: string; active?: boolean; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  const t = useT();
  const tip = keys ? t("wiki.editor.tip", { label, keys }) : label;
  return (
    <button type="button" aria-label={label} title={tip} aria-pressed={active} disabled={disabled}
      onMouseDown={(e) => e.preventDefault()} onClick={onClick}
      className={clsx("inline-flex size-8 shrink-0 items-center justify-center rounded-md transition-colors duration-150 disabled:opacity-35",
        active ? "bg-fg text-bg" : "text-muted hover:bg-surface-2 hover:text-fg")}>
      {children}
    </button>
  );
}

const Gap = () => <span aria-hidden className="w-2 shrink-0" />;

/** A small popover under the toolbar for adding, changing or removing a link (instead of the browser's prompt). */
function LinkEditor({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const t = useT();
  const prev = editor.getAttributes("link").href as string | undefined;
  const [url, setUrl] = useState(prev ?? "");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); inputRef.current?.select(); }, []);
  const apply = (e: React.FormEvent) => {
    e.preventDefault();
    const v = url.trim();
    const c = editor.chain().focus().extendMarkRange("link");
    if (!v) c.unsetLink().run();
    else c.setLink({ href: /^(https?:|mailto:|tel:|\/)/i.test(v) ? v : `https://${v}` }).run();
    onClose();
  };
  return (
    <form onSubmit={apply} onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); editor.commands.focus(); onClose(); } }}
      className="absolute left-2 top-[calc(100%+6px)] z-20 flex w-[min(26rem,calc(100vw-3rem))] items-center gap-1.5 rounded-lg bg-surface p-1.5 shadow-float">
      <label htmlFor="wiki-link-url" className="sr-only">{t("wiki.editor.link.address")}</label>
      <input id="wiki-link-url" ref={inputRef} value={url} onChange={(e) => setUrl(e.target.value)} placeholder={t("wiki.editor.link.placeholder")}
        className="h-8 min-w-0 flex-1 rounded-md bg-surface-2 px-2.5 text-sm outline-none placeholder:text-muted focus:ring-2 focus:ring-accent" />
      <Button type="submit" size="sm">{prev ? t("wiki.editor.link.update") : t("wiki.editor.link.add")}</Button>
      {prev && <Button type="button" size="sm" variant="ghost" onClick={() => { editor.chain().focus().extendMarkRange("link").unsetLink().run(); onClose(); }}>{t("wiki.editor.link.remove")}</Button>}
    </form>
  );
}

function Toolbar({ editor, end, onAsk }: { editor: Editor; end?: ReactNode; onAsk?: () => void }) {
  // Re-render on selection/content changes so active states stay correct.
  const [, force] = useState(0);
  const [linking, setLinking] = useState(false);
  const t = useT();
  const L = (k: string) => t(`wiki.editor.tools.${k}`);
  useEffect(() => {
    const f = () => force((n) => n + 1);
    editor.on("transaction", f);
    return () => { editor.off("transaction", f); };
  }, [editor]);

  const c = () => editor.chain().focus();
  const icon = "size-4";
  return (
    <div className="sticky top-[56px] z-20 rounded-t-lg bg-surface lg:top-0">
      <div className="flex items-center gap-3 border-b border-line px-3 py-2 sm:px-6">
        <div role="toolbar" aria-label={t("wiki.editor.toolbar")} className="-my-1 flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto py-1 [scrollbar-width:none]">
          <ToolButton label={L("heading")} keys="Ctrl+Alt+2" active={editor.isActive("heading", { level: 2 })} onClick={() => c().toggleHeading({ level: 2 }).run()}><Heading2 className={icon} /></ToolButton>
          <ToolButton label={L("subheading")} keys="Ctrl+Alt+3" active={editor.isActive("heading", { level: 3 })} onClick={() => c().toggleHeading({ level: 3 }).run()}><Heading3 className={icon} /></ToolButton>
          <Gap />
          <ToolButton label={L("bold")} keys="Ctrl+B" active={editor.isActive("bold")} onClick={() => c().toggleBold().run()}><Bold className={icon} /></ToolButton>
          <ToolButton label={L("italic")} keys="Ctrl+I" active={editor.isActive("italic")} onClick={() => c().toggleItalic().run()}><Italic className={icon} /></ToolButton>
          <ToolButton label={L("strike")} keys="Ctrl+Shift+S" active={editor.isActive("strike")} onClick={() => c().toggleStrike().run()}><Strikethrough className={icon} /></ToolButton>
          <ToolButton label={L("code")} keys="Ctrl+E" active={editor.isActive("code")} onClick={() => c().toggleCode().run()}><Code className={icon} /></ToolButton>
          <ToolButton label={L("link")} active={editor.isActive("link") || linking} onClick={() => setLinking((v) => !v)}><Link2 className={icon} /></ToolButton>
          <Gap />
          <ToolButton label={L("bullets")} active={editor.isActive("bulletList")} onClick={() => c().toggleBulletList().run()}><List className={icon} /></ToolButton>
          <ToolButton label={L("numbers")} active={editor.isActive("orderedList")} onClick={() => c().toggleOrderedList().run()}><ListOrdered className={icon} /></ToolButton>
          <ToolButton label={L("checklist")} active={editor.isActive("taskList")} onClick={() => c().toggleTaskList().run()}><ListChecks className={icon} /></ToolButton>
          <ToolButton label={L("quote")} active={editor.isActive("blockquote")} onClick={() => c().toggleBlockquote().run()}><Quote className={icon} /></ToolButton>
          <ToolButton label={L("codeBlock")} active={editor.isActive("codeBlock")} onClick={() => c().toggleCodeBlock().run()}><SquareCode className={icon} /></ToolButton>
          <Gap />
          <ToolButton label={L("mention")} keys="@" onClick={() => c().insertContent(" @").run()}><AtSign className={icon} /></ToolButton>
          <ToolButton label={L("pageLink")} keys="[[" onClick={() => c().insertContent(" [[").run()}><FileText className={icon} /></ToolButton>
          {onAsk && <><Gap /><ToolButton label={L("ask")} keys="Ctrl+J" onClick={onAsk}><Sparkles className={clsx(icon, "text-accent")} /></ToolButton></>}
          <Gap />
          <ToolButton label={L("undo")} keys="Ctrl+Z" disabled={!editor.can().undo()} onClick={() => c().undo().run()}><Undo2 className={icon} /></ToolButton>
          <ToolButton label={L("redo")} keys="Ctrl+Shift+Z" disabled={!editor.can().redo()} onClick={() => c().redo().run()}><Redo2 className={icon} /></ToolButton>
        </div>
        {end && <div className="flex shrink-0 items-center gap-3">{end}</div>}
      </div>
      {linking && <LinkEditor editor={editor} onClose={() => setLinking(false)} />}
    </div>
  );
}

/* ── Editor ────────────────────────────────────────────────────────────────────────────────────────────── */

export type WikiEditorProps = {
  pageId: string;
  pageVisibility: Visibility;
  /** A family graph: family wording and examples in co-writing. */
  family?: boolean;
  initialContent: Doc;
  onChange: (doc: Doc) => void;
  onReady?: (editor: Editor) => void;
  labelledBy?: string;
  /** Shown at the right end of the toolbar: the save state and Done. */
  toolbarEnd?: ReactNode;
  /** Rendered on the page above the text: the title field. */
  children?: ReactNode;
  /** Co-writing with the assistant. Omit to hide it (e.g. for people who can't edit). */
  cowrite?: {
    slug: string;
    /** Bump to open the composer from outside (e.g. "Ask the assistant" on the read view). */
    openSignal?: number;
    onAccept: (fullDoc: Doc, info: AcceptInfo) => Promise<AcceptResult>;
    onPendingChange?: (pending: boolean) => void;
  };
};

export function WikiEditor({ pageId, pageVisibility, family = false, initialContent, onChange, onReady, labelledBy, toolbarEnd, children, cowrite }: WikiEditorProps) {
  const t = useT();
  const tRef = useRef<TFn>(t);
  tRef.current = t;
  const [popup, setPopup] = useState<Popup | null>(null);
  const [asking, setAsking] = useState(false);
  const openSignal = cowrite?.openSignal ?? 0;
  useEffect(() => { if (openSignal > 0) setAsking(true); }, [openSignal]);
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

  /** The [[ suggestion lifecycle: mirror its state into React and handle the keyboard. */
  const renderer = () => () => ({
    onStart: (props: SuggestionProps<PageItem, MentionNodeAttrs>) => {
      indexRef.current = 0; setIndex(0);
      show({ items: props.items, query: props.query, rect: props.clientRect?.() ?? null, select: (item) => props.command(item as never) });
    },
    onUpdate: (props: SuggestionProps<PageItem, MentionNodeAttrs>) => {
      show({ items: props.items, query: props.query, rect: props.clientRect?.() ?? null, select: (item) => props.command(item as never) });
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
      Cowrite,
      Placeholder.configure({
        placeholder: ({ node }) => node.type.name === "heading" ? tRef.current("wiki.editor.heading") : tRef.current("wiki.editor.placeholder"),
        emptyEditorClass: "is-editor-empty",
      }),
      // The shared @mention: same typeahead and markup as the chat composer. The chip keeps the wiki's look so
      // writing matches reading (PersonChip / NodeChip in the read view).
      graphMention().configure({
        renderHTML: ({ options, node }) => {
          const chip = mentionChip(String(node.attrs.id ?? ""), node.attrs.nodeType as string | null);
          return ["span", mergeAttributes(options.HTMLAttributes, { "data-node-id": String(node.attrs.id ?? "") }, chip), String(node.attrs.label ?? "")];
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
                if (!res.ok) throw new Error(data.error ?? tRef.current("wiki.editor.pages.createFailed"));
                insert({ id: data.page.id, label: data.page.title, slug: data.page.slug });
                setNotice(tRef.current("wiki.editor.pages.created", { title: data.page.title }));
              } catch (e) {
                setNotice(e instanceof Error ? e.message : tRef.current("wiki.editor.pages.createFailed"));
              }
            })();
          },
          render: renderer(),
        },
      }),
    ],
    editorProps: {
      attributes: {
        class: clsx(PROSE, COWRITE_CLASSES, "min-h-[50vh] pb-24 outline-none caret-accent",
          "[&_p.is-editor-empty:first-child]:before:pointer-events-none [&_p.is-editor-empty:first-child]:before:float-left [&_p.is-editor-empty:first-child]:before:h-0 [&_p.is-editor-empty:first-child]:before:text-muted [&_p.is-editor-empty:first-child]:before:content-[attr(data-placeholder)]"),
        role: "textbox",
        // Writing on the page itself: the caret shows focus, not a ring around the whole text.
        style: "outline: none",
        "aria-multiline": "true",
        ...(labelledBy ? { "aria-labelledby": labelledBy } : { "aria-label": tRef.current("wiki.editor.pageText") }),
      },
    },
    // Autosave never stores the assistant's draft: only the person's own text, until they accept the draft.
    onUpdate: ({ editor, transaction }) => { if (!isCowriteTr(transaction)) onChangeRef.current(savedDocOf(editor)); },
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

  const sheet = "px-5 pt-8 sm:px-12 sm:pt-12 lg:px-16";
  if (!editor) {
    return (
      <div aria-busy="true">
        <div className="h-[49px] rounded-t-lg border-b border-line" />
        <div className={sheet}>
          {children}
          <div className="mt-6 max-w-[68ch] space-y-3">{[92, 100, 76].map((w) => <div key={w} className="h-4 animate-pulse rounded bg-surface-2" style={{ width: `${w}%` }} />)}</div>
          <span className="sr-only">{t("wiki.editor.loading")}</span>
        </div>
      </div>
    );
  }
  return (
    <div>
      <Toolbar editor={editor} end={toolbarEnd} onAsk={cowrite ? () => setAsking(true) : undefined} />
      <div className={sheet}>
        {children}
        <EditorContent editor={editor} className="mt-6" />
      </div>
      {cowrite && (
        <CowritePanel editor={editor} slug={cowrite.slug} pageVisibility={pageVisibility} family={family} open={asking} onOpenChange={setAsking}
          onAccept={cowrite.onAccept} onPendingChange={cowrite.onPendingChange} />
      )}
      {popup && <SuggestionList popup={popup} index={index} onHover={move} listId={listId} />}
      <p role="status" aria-live="polite" className={clsx("fixed bottom-24 left-1/2 z-40 -translate-x-1/2 rounded-lg bg-fg px-4 py-2.5 text-sm text-bg shadow-float lg:bottom-8", !notice && "sr-only")}>{notice}</p>
    </div>
  );
}
