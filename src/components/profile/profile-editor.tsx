"use client";
/**
 * The written part of a profile: a Notion-like block editor (TipTap) that saves itself as versions.
 *   /   block commands: heading, text, lists, checklist, fact, table, image from the library, quote, toggle, divider
 *   @   mention anything in the graph (the shared mention typeahead)
 * While someone writes, the live highlighter reads the paragraph ("has two kids, Ida and Karl") and marks what it
 * would add; one click adds it to the graph as the person's own change.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { EditorContent, Extension, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { PluginKey } from "@tiptap/pm/state";
import Suggestion, { type SuggestionKeyDownProps, type SuggestionProps } from "@tiptap/suggestion";
import { clsx } from "clsx";
import {
  AtSign, CheckSquare, ChevronRight, Heading2, Heading3, Image as ImageIcon, List, ListOrdered, Minus, Quote, Sparkles, Table as TableIcon, Text, Waypoints,
} from "lucide-react";
import { Button } from "@/components/ui";
import { graphMention } from "@/components/mention/tiptap";
import { mentionChip, PROSE } from "@/components/wiki/prose";
import { useT } from "@/lib/i18n/client";
import type { TFn } from "@/lib/i18n/core";
import type { AnnotateResult } from "@/lib/mentions/annotate";
import type { ProfileDoc } from "@/lib/profile/doc";
import { FactRef, highlightKey, LibraryImage, LiveHighlights, Table, TableCell, TableHeader, TableRoles, TableRow, Toggle, type HighlightTerm } from "./extensions";
import { mergeAttributes } from "@tiptap/react";

/* ── Slash commands ────────────────────────────────────────────────────────────────────────────────────── */

type SlashItem = { key: string; icon: ReactNode; keywords: string; run: (editor: Editor) => void };

function slashItems(t: TFn, on: { fact: () => void; image: () => void }): SlashItem[] {
  const i = "size-4";
  const L = (k: string) => t(`profile.slash.${k}`);
  return [
    { key: "text", icon: <Text className={i} />, keywords: `${L("text")} paragraph tekst`, run: (e) => e.chain().focus().setParagraph().run() },
    { key: "heading", icon: <Heading2 className={i} />, keywords: `${L("heading")} h2 title overskrift`, run: (e) => e.chain().focus().toggleHeading({ level: 2 }).run() },
    { key: "subheading", icon: <Heading3 className={i} />, keywords: `${L("subheading")} h3`, run: (e) => e.chain().focus().toggleHeading({ level: 3 }).run() },
    { key: "fact", icon: <Waypoints className={i} />, keywords: `${L("fact")} graph relation has fakta`, run: () => on.fact() },
    { key: "bullets", icon: <List className={i} />, keywords: `${L("bullets")} list ul punkter`, run: (e) => e.chain().focus().toggleBulletList().run() },
    { key: "numbers", icon: <ListOrdered className={i} />, keywords: `${L("numbers")} ol numbered`, run: (e) => e.chain().focus().toggleOrderedList().run() },
    { key: "checklist", icon: <CheckSquare className={i} />, keywords: `${L("checklist")} todo task tjekliste`, run: (e) => e.chain().focus().toggleTaskList().run() },
    { key: "table", icon: <TableIcon className={i} />, keywords: `${L("table")} grid tabel`, run: (e) => e.chain().focus().insertProfileTable(3, 2).run() },
    { key: "image", icon: <ImageIcon className={i} />, keywords: `${L("image")} photo picture library billede foto`, run: () => on.image() },
    { key: "quote", icon: <Quote className={i} />, keywords: `${L("quote")} blockquote citat`, run: (e) => e.chain().focus().toggleBlockquote().run() },
    { key: "toggle", icon: <ChevronRight className={i} />, keywords: `${L("toggle")} collapse details fold`, run: (e) => e.chain().focus().insertToggle().run() },
    { key: "divider", icon: <Minus className={i} />, keywords: `${L("divider")} hr line streg`, run: (e) => e.chain().focus().setHorizontalRule().run() },
    { key: "mention", icon: <AtSign className={i} />, keywords: `${L("mention")} @ link nævn`, run: (e) => e.chain().focus().insertContent("@").run() },
  ];
}

type SlashState = { items: SlashItem[]; rect: DOMRect | null; select: (item: SlashItem) => void };

function SlashMenu({ state, index, onHover, listId }: { state: SlashState; index: number; onHover: (i: number) => void; listId: string }) {
  const t = useT();
  const rect = state.rect;
  const top = rect ? (window.innerHeight - rect.bottom < 320 && rect.top > 320 ? undefined : rect.bottom + 6) : undefined;
  const bottom = rect && top === undefined ? window.innerHeight - rect.top + 6 : undefined;
  const left = rect ? Math.max(8, Math.min(rect.left, window.innerWidth - 288)) : 8;
  return (
    <div className="fixed z-50 w-[min(280px,calc(100vw-16px))] rounded-lg bg-surface p-1.5 font-sans shadow-float" style={{ top, bottom, left, visibility: rect ? "visible" : "hidden" }}>
      <p className="px-2.5 pb-1 pt-1 text-xs text-muted">{t("profile.slash.title")}</p>
      <div role="listbox" id={listId} aria-label={t("profile.slash.title")} className="max-h-72 overflow-y-auto">
        {state.items.length === 0 && <p className="px-2.5 py-2 text-sm text-muted">{t("profile.slash.none")}</p>}
        {state.items.map((it, i) => (
          <button key={it.key} id={`${listId}-${i}`} type="button" role="option" aria-selected={i === index}
            onMouseDown={(e) => { e.preventDefault(); state.select(it); }} onMouseEnter={() => onHover(i)}
            className={clsx("flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm", i === index ? "bg-surface-2" : "")}>
            <span className="grid size-7 shrink-0 place-items-center rounded-md bg-surface-2 text-muted">{it.icon}</span>
            <span className="min-w-0">
              <span className="block">{t(`profile.slash.${it.key}`)}</span>
              <span className="block truncate text-xs text-muted">{t(`profile.slash.${it.key}Hint`)}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

/* ── Editor ────────────────────────────────────────────────────────────────────────────────────────────── */

export type SaveState = "idle" | "saving" | "saved" | "error" | "conflict";

export type ProfileEditorHandle = {
  insertFact: (f: { edgeId: string | null; otherId: string; otherLabel: string; otherType: string; phrase: string }) => void;
  insertImage: (img: { sourceId: string; alt: string }) => void;
};

type Props = {
  nodeId: string;
  name: string;
  initialDoc: ProfileDoc;
  initialVersion: number;
  editable: boolean;
  /** Live highlights + adding what they found (people who may write in the graph). */
  highlights: boolean;
  onFactCommand: () => void;
  onImageCommand: () => void;
  onReady?: (h: ProfileEditorHandle) => void;
  onSaved?: (version: number) => void;
  /** Facts were added from the highlights: reload the profile. */
  onFactsAdded?: () => void;
};

const SAVE_MS = 1200;
const READ_MS = 1400;

export function ProfileEditor({ nodeId, name, initialDoc, initialVersion, editable, highlights, onFactCommand, onImageCommand, onReady, onSaved, onFactsAdded }: Props) {
  const t = useT();
  const tRef = useRef(t);
  tRef.current = t;
  const [save, setSave] = useState<SaveState>("idle");
  const versionRef = useRef(initialVersion);
  const pending = useRef<ProfileDoc | null>(null);
  const timer = useRef<number | null>(null);
  const saving = useRef(false);
  const [slash, setSlash] = useState<SlashState | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  const slashRef = useRef<SlashState | null>(null);
  const slashIndexRef = useRef(0);
  const cmds = useRef({ fact: onFactCommand, image: onImageCommand });
  cmds.current = { fact: onFactCommand, image: onImageCommand };
  const listId = `profile-slash-${nodeId}`;

  // Live highlights state.
  const [found, setFound] = useState<{ text: string; result: AnnotateResult } | null>(null);
  const [reading, setReading] = useState(false);
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const dismissed = useRef(new Set<string>());
  const readTimer = useRef<number | null>(null);
  const abort = useRef<AbortController | null>(null);

  const flush = useCallback(async () => {
    if (saving.current || !pending.current) return;
    const doc = pending.current;
    pending.current = null;
    saving.current = true;
    setSave("saving");
    try {
      const res = await fetch(`/api/profile/${nodeId}/doc`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ doc, baseVersion: versionRef.current }) });
      const data = await res.json().catch(() => ({}));
      if (res.status === 409) { setSave("conflict"); return; }
      if (!res.ok) { setSave("error"); pending.current = pending.current ?? doc; return; }
      versionRef.current = data.version;
      setSave("saved");
      if (!data.unchanged) onSaved?.(data.version);
    } catch {
      setSave("error");
      pending.current = pending.current ?? doc;
    } finally {
      saving.current = false;
      if (pending.current) timer.current = window.setTimeout(() => void flush(), SAVE_MS);
    }
  }, [nodeId, onSaved]);

  const schedule = (doc: ProfileDoc) => {
    pending.current = doc;
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void flush(), SAVE_MS);
  };

  const SlashCommands = useRef(Extension.create({
    name: "profileSlash",
    addProseMirrorPlugins() {
      const show = (s: SlashState | null) => {
        slashRef.current = s;
        setSlash(s);
        if (!s || slashIndexRef.current >= s.items.length) { slashIndexRef.current = 0; setSlashIndex(0); }
      };
      return [Suggestion<SlashItem>({
        editor: this.editor,
        char: "/",
        pluginKey: new PluginKey("profileSlash"),
        allowSpaces: false,
        startOfLine: false,
        items: ({ query }) => {
          const q = query.toLowerCase().trim();
          const all = slashItems(tRef.current, { fact: () => cmds.current.fact(), image: () => cmds.current.image() });
          return q ? all.filter((i) => i.keywords.toLowerCase().includes(q)) : all;
        },
        command: ({ editor, range, props }) => {
          editor.chain().focus().deleteRange(range).run();
          props.run(editor);
        },
        render: () => ({
          onStart: (p: SuggestionProps<SlashItem>) => show({ items: p.items, rect: p.clientRect?.() ?? null, select: (it) => p.command(it) }),
          onUpdate: (p: SuggestionProps<SlashItem>) => show({ items: p.items, rect: p.clientRect?.() ?? null, select: (it) => p.command(it) }),
          onKeyDown: ({ event }: SuggestionKeyDownProps) => {
            const s = slashRef.current;
            if (!s) return false;
            if (event.key === "Escape") { show(null); return true; }
            if (!s.items.length) return false;
            const move = (i: number) => { slashIndexRef.current = i; setSlashIndex(i); };
            if (event.key === "ArrowDown") { move((slashIndexRef.current + 1) % s.items.length); return true; }
            if (event.key === "ArrowUp") { move((slashIndexRef.current - 1 + s.items.length) % s.items.length); return true; }
            if (event.key === "Enter" || event.key === "Tab") { s.select(s.items[slashIndexRef.current]); return true; }
            return false;
          },
          onExit: () => show(null),
        }),
      })];
    },
  })).current;

  const editor = useEditor({
    immediatelyRender: false,
    editable,
    content: initialDoc,
    extensions: [
      StarterKit.configure({
        heading: { levels: [2, 3] },
        link: { openOnClick: !editable, autolink: true, defaultProtocol: "https", protocols: ["http", "https", "mailto", "tel"], HTMLAttributes: { rel: "noopener noreferrer nofollow" } },
      }),
      TaskList, TaskItem.configure({ nested: true }),
      Toggle, TableRoles, Table, TableRow, TableHeader, TableCell, LibraryImage, FactRef, LiveHighlights, SlashCommands,
      Placeholder.configure({
        placeholder: ({ node }) => (node.type.name === "heading" ? tRef.current("profile.editor.heading") : tRef.current("profile.editor.placeholder", { name: name.split(" ")[0] })),
        emptyEditorClass: "is-editor-empty",
      }),
      graphMention().configure({
        renderHTML: ({ options, node }) => {
          const chip = mentionChip(String(node.attrs.id ?? ""), node.attrs.nodeType as string | null);
          return ["span", mergeAttributes(options.HTMLAttributes, { "data-node-id": String(node.attrs.id ?? "") }, chip), String(node.attrs.label ?? "")];
        },
      }),
    ],
    editorProps: {
      attributes: {
        class: clsx(PROSE, "min-h-[8rem] pb-6 outline-none caret-accent [&_details]:my-3",
          "[&_p.is-editor-empty:first-child]:before:pointer-events-none [&_p.is-editor-empty:first-child]:before:float-left [&_p.is-editor-empty:first-child]:before:h-0 [&_p.is-editor-empty:first-child]:before:text-muted [&_p.is-editor-empty:first-child]:before:content-[attr(data-placeholder)]",
          "[&_.selectedCell]:bg-accent-tint"),
        role: "textbox",
        "aria-multiline": "true",
        "aria-label": tRef.current("profile.editor.label", { name }),
        style: "outline: none",
      },
    },
    onUpdate: ({ editor }) => {
      schedule(editor.getJSON() as ProfileDoc);
      if (highlights) scheduleRead(editor);
    },
  });

  /** Read the paragraph being written after a pause, and mark what it would add. */
  const scheduleRead = (ed: Editor) => {
    if (readTimer.current) window.clearTimeout(readTimer.current);
    readTimer.current = window.setTimeout(async () => {
      const { $from } = ed.state.selection;
      const block = $from.parent.textContent.trim();
      if (block.length < 12 || dismissed.current.has(block)) return;
      const named = block.toLowerCase().includes(name.toLowerCase().split(" ")[0]);
      const text = named ? block : `${name}: ${block}`;
      abort.current?.abort();
      const ac = new AbortController();
      abort.current = ac;
      setReading(true);
      try {
        const res = await fetch("/api/annotate", {
          method: "POST", headers: { "content-type": "application/json" }, signal: ac.signal,
          body: JSON.stringify({ text, mentions: [{ label: name, nodeId }] }),
        });
        if (!res.ok) return;
        const result = (await res.json()) as AnnotateResult;
        const terms: HighlightTerm[] = result.spans.filter((s) => s.text && !(s.type === "person" && s.text.toLowerCase() === name.toLowerCase()) && s.start >= (named ? 0 : name.length + 2))
          .map((s) => ({ text: s.text.replace(/^@/, ""), tone: s.tone, tag: s.tag }));
        ed.view.dispatch(ed.state.tr.setMeta(highlightKey, terms));
        const useful = !result.readOnly && (result.summary.facts > 0 || result.summary.things > 0);
        setFound(useful ? { text, result } : null);
      } catch { /* aborted or offline */ } finally {
        if (abort.current === ac) setReading(false);
      }
    }, READ_MS);
  };

  const clearHighlights = () => { if (editor) editor.view.dispatch(editor.state.tr.setMeta(highlightKey, [])); };

  const addFound = async () => {
    if (!found) return;
    setAdding(true);
    try {
      const res = await fetch("/api/annotate/commit", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: found.text, plan: { entities: found.result.plan.entities, facts: found.result.plan.facts, kinds: found.result.plan.kinds, relations: found.result.plan.relations } }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setNotice(data.error ?? t("profile.highlights.failed")); return; }
      dismissed.current.add(found.text.replace(`${name}: `, ""));
      setFound(null);
      clearHighlights();
      setNotice(t("profile.highlights.added", { count: data.applied ?? 0 }));
      onFactsAdded?.();
    } finally { setAdding(false); }
  };

  useEffect(() => {
    if (!editor || !onReady) return;
    onReady({
      insertFact: (f) => editor.chain().focus().insertContent([{ type: "factRef", attrs: f }, { type: "text", text: " " }]).run(),
      insertImage: (img) => editor.chain().focus().insertLibraryImage(img).run(),
    });
  }, [editor, onReady]);

  useEffect(() => { if (editor && editor.isEditable !== editable) editor.setEditable(editable, false); }, [editor, editable]);

  // Save on leave; never lose a paragraph.
  useEffect(() => {
    const before = (e: BeforeUnloadEvent) => { if (pending.current || saving.current) { void flush(); e.preventDefault(); } };
    window.addEventListener("beforeunload", before);
    return () => { window.removeEventListener("beforeunload", before); if (pending.current) void flush(); };
  }, [flush]);

  useEffect(() => {
    if (!notice) return;
    const id = window.setTimeout(() => setNotice(null), 5000);
    return () => window.clearTimeout(id);
  }, [notice]);

  const inTable = !!editor?.isActive("table");

  return (
    <div>
      {editable && (
        <div className="mb-2 flex min-h-6 flex-wrap items-center justify-between gap-2 text-xs text-muted">
          <span>{t("profile.editor.hint")}</span>
          <span role="status" aria-live="polite" className={clsx(save === "error" || save === "conflict" ? "text-danger" : "")}>
            {save === "saving" ? t("profile.editor.saving") : save === "saved" ? t("profile.editor.saved") : save === "error" ? t("profile.editor.saveFailed")
              : save === "conflict" ? <>{t("profile.editor.conflict")} <button type="button" className="text-accent underline" onClick={() => window.location.reload()}>{t("profile.editor.reload")}</button></> : null}
          </span>
        </div>
      )}
      {inTable && editable && editor && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          <Button size="sm" variant="secondary" onClick={() => editor.chain().focus().addProfileRow().run()}>{t("profile.table.addRow")}</Button>
          <Button size="sm" variant="secondary" onClick={() => editor.chain().focus().addProfileColumn().run()}>{t("profile.table.addColumn")}</Button>
          <Button size="sm" variant="ghost" onClick={() => editor.chain().focus().deleteProfileRow().run()}>{t("profile.table.deleteRow")}</Button>
          <Button size="sm" variant="ghost" onClick={() => editor.chain().focus().deleteProfileColumn().run()}>{t("profile.table.deleteColumn")}</Button>
          <Button size="sm" variant="ghost" onClick={() => editor.chain().focus().deleteProfileTable().run()}>{t("profile.table.delete")}</Button>
        </div>
      )}
      {editor ? <EditorContent editor={editor} /> : <div className="h-32 animate-pulse rounded-lg bg-surface-2" aria-busy="true" />}

      {highlights && (found || reading) && (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-accent-tint/60 px-3 py-2 text-sm" aria-live="polite">
          <Sparkles aria-hidden className="size-4 shrink-0 text-accent" />
          {found ? (
            <>
              <span className="min-w-0 flex-1">
                {t("profile.highlights.found", {
                  facts: t("profile.highlights.facts", { count: found.result.summary.facts }),
                  things: t("profile.highlights.things", { count: found.result.summary.things }),
                })}
                {found.result.muxDown && <span className="text-muted"> {t("profile.highlights.muxDown")}</span>}
              </span>
              <Button size="sm" onClick={addFound} disabled={adding}>{adding ? t("profile.highlights.adding") : t("profile.highlights.add", { name: name.split(" ")[0] })}</Button>
              <Button size="sm" variant="ghost" onClick={() => { dismissed.current.add(found.text.replace(`${name}: `, "")); setFound(null); clearHighlights(); }}>{t("profile.highlights.notNow")}</Button>
            </>
          ) : <span className="text-muted">{t("profile.highlights.reading")}</span>}
        </div>
      )}
      {slash && <SlashMenu state={slash} index={slashIndex} onHover={(i) => { slashIndexRef.current = i; setSlashIndex(i); }} listId={listId} />}
      <p role="status" aria-live="polite" className={clsx("fixed bottom-24 left-1/2 z-40 -translate-x-1/2 rounded-lg bg-fg px-4 py-2.5 text-sm text-bg shadow-float lg:bottom-8", !notice && "sr-only")}>{notice}</p>
    </div>
  );
}
