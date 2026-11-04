"use client";
/**
 * "Ask the assistant to write…" inside the page editor (Scout's co-create).
 *
 *   composing  a short request + where to write: a new section at the cursor, the selected text, or the whole page
 *   writing    "Assistant is writing": its text streams into the page, highlighted, with its own caret. The view
 *              follows only when the person has been idle for 3 s; it never takes focus. Stop keeps what's there.
 *   review     the draft stays highlighted as a pending change: Accept saves it as the assistant's own revision,
 *              Undo removes exactly what it wrote. A warning shows when it drew on items fewer people can see.
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { AnimatePresence, motion } from "motion/react";
import { clsx } from "clsx";
import { AlertTriangle, Sparkles, Square, X } from "lucide-react";
import { Badge, Button, CitationChip, IconButton } from "@/components/ui";
import { extractMentions, extractPageLinks, type Doc, type DocNode } from "@/lib/wiki/doc";
import type { Visibility } from "@/lib/wiki/labels";
import { citeHref, docToMarkdown, markdownToBlocks, newTerms, wordCount, type KnownRefs } from "@/lib/wiki/cowrite/markdown";
import { beginEdit, blocksToFragment, docWithoutEdit, renderInto, revertEdit } from "@/lib/wiki/cowrite/pending";
import { sensitivityWarning, type CowriteEvent, type CowriteMode, type CowriteSourceOut } from "@/lib/wiki/cowrite/prompt";
import { asAssistant, getCowrite } from "./extension";

export type AcceptInfo = { instruction: string; mode: CowriteMode; words: number; sourceCount: number; usedNarrower: boolean };
export type AcceptResult = { ok: true } | { ok: false; error: string };

type Phase = "closed" | "composing" | "writing" | "review";

const IDLE_FOLLOW_MS = 3000;
const RENDER_EVERY_MS = 90;

const EXAMPLES: Record<CowriteMode, string[]> = {
  insert: ["Draft a packing list for the summer house from last year's trip", "Add a section with the important dates this term"],
  rewrite: ["Make this shorter and clearer", "Turn this into a checklist"],
  page: ["Update this page with the new school times", "Tidy this page up and add headings"],
};

const MODE_OPTIONS: { mode: CowriteMode; label: string; short: string }[] = [
  { mode: "insert", label: "New section here", short: "New section" },
  { mode: "rewrite", label: "Rewrite selection", short: "Selection" },
  { mode: "page", label: "Whole page", short: "Whole page" },
];

function useReducedMotion() {
  const [r, setR] = useState(false);
  useEffect(() => {
    const m = window.matchMedia("(prefers-reduced-motion: reduce)");
    setR(m.matches);
    const h = () => setR(m.matches);
    m.addEventListener("change", h);
    return () => m.removeEventListener("change", h);
  }, []);
  return r;
}

export function CowritePanel({ editor, slug, pageVisibility, open, onOpenChange, onAccept, onPendingChange }: {
  editor: Editor;
  slug: string;
  pageVisibility: Visibility;
  /** Ask to show the composer (the toolbar button, Ctrl+J, or "Ask the assistant" on the read view). */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Save the whole page (the person's text plus the draft) as the assistant's revision. */
  onAccept: (fullDoc: Doc, info: AcceptInfo) => Promise<AcceptResult>;
  onPendingChange?: (pending: boolean) => void;
}) {
  const [phase, setPhase] = useState<Phase>("closed");
  const [instruction, setInstruction] = useState("");
  const [mode, setMode] = useState<CowriteMode>("insert");
  const [hasSelection, setHasSelection] = useState(false);
  const [sources, setSources] = useState<CowriteSourceOut[]>([]);
  const [cited, setCited] = useState<number[]>([]);
  const [words, setWords] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);
  /** The draft adds words the page didn't have (so an uncited draft may still carry what it read). */
  const [addsNew, setAddsNew] = useState(true);
  const pageMd = useRef("");
  const reduced = useReducedMotion();
  const id = useId();

  const md = useRef("");
  const asked = useRef<{ instruction: string; mode: CowriteMode }>({ instruction: "", mode: "insert" });
  const refs = useRef<KnownRefs>({});
  const sourcesRef = useRef<CowriteSourceOut[]>([]);
  const abort = useRef<AbortController | null>(null);
  const lastActive = useRef(0);
  const lastRender = useRef(0);
  const renderTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const pending = phase === "writing" || phase === "review";
  useEffect(() => { onPendingChange?.(pending); }, [pending, onPendingChange]);

  // Open from outside (toolbar, shortcut, read view).
  useEffect(() => {
    if (!open) return;
    if (phase === "closed") {
      // Opened without a place in the page (from the read view): a new section goes at the end.
      if (!editor.isFocused && editor.state.selection.empty && editor.state.selection.from <= 1) {
        editor.commands.setTextSelection(editor.state.doc.content.size);
      }
      const sel = editor.state.selection;
      setMode(sel.to > sel.from ? "rewrite" : "insert");
      setError(null);
      setPhase("composing");
    }
    onOpenChange(false);
  }, [open, phase, editor, onOpenChange]);

  useEffect(() => { if (phase === "composing") inputRef.current?.focus(); }, [phase]);

  // Whether there is a selection to rewrite, and whether the person edited inside the draft.
  useEffect(() => {
    const h = () => {
      const sel = editor.state.selection;
      setHasSelection(sel.to > sel.from);
      setTouched(getCowrite(editor.state).touched);
    };
    h();
    editor.on("transaction", h);
    return () => { editor.off("transaction", h); };
  }, [editor]);

  // Ctrl/Cmd+J opens the composer; Escape closes it.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "j") {
        e.preventDefault();
        if (phase === "closed") onOpenChange(true);
        else if (phase === "composing") inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [phase, onOpenChange]);

  // The person counts as active when they type, click, touch or scroll themselves.
  useEffect(() => {
    const mark = () => { lastActive.current = Date.now(); };
    const opts = { capture: true, passive: true } as const;
    for (const ev of ["keydown", "pointerdown", "wheel", "touchmove"] as const) window.addEventListener(ev, mark, opts);
    return () => { for (const ev of ["keydown", "pointerdown", "wheel", "touchmove"] as const) window.removeEventListener(ev, mark, opts); };
  }, []);

  useEffect(() => () => { abort.current?.abort(); if (renderTimer.current) clearTimeout(renderTimer.current); }, []);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(t);
  }, [notice]);

  /** Follow the assistant's caret, but only if the person has left the page alone for a few seconds. */
  const follow = useCallback(() => {
    if (Date.now() - lastActive.current < IDLE_FOLLOW_MS) return;
    const caret = editor.view.dom.querySelector(".cowrite-caret");
    if (!caret) return;
    const r = caret.getBoundingClientRect();
    const bottom = window.innerHeight - 160; // keep clear of this panel and the phone's bottom bar
    const top = 96; // and of the sticky toolbar
    const by = r.bottom > bottom ? r.bottom - bottom : r.top < top ? r.top - top - 24 : 0;
    if (by) window.scrollBy({ top: by, behavior: reduced ? "auto" : "smooth" });
  }, [editor, reduced]);

  /** Put the latest markdown into the page, replacing the assistant's previous render. */
  const render = useCallback((final: boolean) => {
    const s = getCowrite(editor.state);
    if (!s.edit) return;
    const parsed = markdownToBlocks(md.current, { cites: sourcesRef.current, refs: refs.current, final });
    const frag = blocksToFragment(editor.schema, parsed.blocks);
    const tr = editor.state.tr;
    const next = renderInto(tr, s.edit, frag);
    editor.view.dispatch(asAssistant(tr, { edit: next, streaming: !final }));
    setWords(wordCount(parsed.blocks));
    setCited(parsed.cited);
    lastRender.current = Date.now();
    if (!final) follow();
  }, [editor, follow]);

  const scheduleRender = useCallback(() => {
    if (renderTimer.current) return;
    const wait = Math.max(0, RENDER_EVERY_MS - (Date.now() - lastRender.current));
    renderTimer.current = setTimeout(() => { renderTimer.current = null; render(false); }, wait);
  }, [render]);

  const undoDraft = useCallback(() => {
    const s = getCowrite(editor.state);
    if (!s.edit) return;
    const tr = editor.state.tr;
    revertEdit(tr, s.edit);
    editor.view.dispatch(asAssistant(tr, { edit: null, streaming: false }));
  }, [editor]);

  const start = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const ask = instruction.trim();
    if (ask.length < 3) { setError("Tell the assistant what to write."); inputRef.current?.focus(); return; }
    const { state } = editor;
    const sel = state.selection;
    if (mode === "rewrite" && sel.to <= sel.from) { setError("Select the text you want rewritten first, or choose another option."); return; }

    const edit = beginEdit(state.doc, mode, { from: sel.from, to: sel.to });
    const pageJson = state.doc.toJSON() as DocNode;
    refs.current = { mentions: extractMentions(pageJson), pages: extractPageLinks(pageJson) };
    const selectionMarkdown = mode === "rewrite" ? docToMarkdown({ type: "doc", content: edit.original.content.toJSON() as DocNode[] }) : undefined;
    md.current = "";
    pageMd.current = docToMarkdown(pageJson);
    sourcesRef.current = [];
    asked.current = { instruction: ask, mode };
    setSources([]); setCited([]); setWords(0); setError(null);
    editor.view.dispatch(asAssistant(state.tr, { edit, streaming: true }));
    setPhase("writing");
    lastActive.current = 0; // the person just asked: following is welcome until they touch the page again
    lastRender.current = 0;

    const ac = new AbortController();
    abort.current = ac;
    let failed: string | null = null;
    try {
      const res = await fetch(`/api/wiki/${encodeURIComponent(slug)}/cowrite`, {
        method: "POST", headers: { "content-type": "application/json" }, signal: ac.signal,
        body: JSON.stringify({ instruction: ask, mode, pageMarkdown: pageMd.current, selectionMarkdown }),
      });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? (res.status === 401 ? "You've been signed out. Sign in again, then ask again." : "The assistant couldn't write this. Try again."));
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const raw = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!raw) continue;
          let ev: CowriteEvent;
          try { ev = JSON.parse(raw); } catch { continue; }
          if (ev.type === "sources") { sourcesRef.current = ev.sources; setSources(ev.sources); }
          else if (ev.type === "delta") { md.current += ev.text; scheduleRender(); }
          else if (ev.type === "error") failed = ev.error;
        }
      }
    } catch (err) {
      if ((err as Error)?.name !== "AbortError") failed = err instanceof Error ? err.message : "The assistant couldn't write this. Try again.";
    } finally {
      abort.current = null;
      if (renderTimer.current) { clearTimeout(renderTimer.current); renderTimer.current = null; }
    }

    if (!md.current.trim()) {
      undoDraft();
      setError(failed ?? "The assistant stopped before writing anything. Your page is unchanged.");
      setPhase("composing");
      return;
    }
    render(true);
    setAddsNew(newTerms(markdownToBlocks(md.current, { cites: sourcesRef.current, refs: refs.current, final: true }).blocks, pageMd.current).length > 0);
    if (failed) setError(failed);
    setPhase("review");
  };

  const stop = () => abort.current?.abort();

  const accept = async () => {
    const s = getCowrite(editor.state);
    if (!s.edit) { setPhase("closed"); return; }
    setBusy(true); setError(null);
    const used = sourcesRef.current.filter((x) => cited.includes(x.n));
    const res = await onAccept(editor.getJSON() as Doc, {
      instruction: asked.current.instruction, mode: asked.current.mode, words,
      sourceCount: used.length, usedNarrower: !!warning,
    });
    setBusy(false);
    if (!res.ok) { setError(res.error); return; }
    editor.view.dispatch(asAssistant(editor.state.tr, { edit: null, streaming: false }));
    setNotice("Kept. It's saved as the assistant's version in the page history.");
    setInstruction("");
    setPhase("closed");
  };

  const undo = () => {
    undoDraft();
    setNotice("Undone. The assistant's text is gone; your own edits are still there.");
    setPhase("closed");
  };

  const tryAgain = () => {
    undoDraft();
    setInstruction(asked.current.instruction);
    setMode(asked.current.mode);
    setError(null);
    setPhase("composing");
  };

  const close = () => { setPhase("closed"); setError(null); };

  // Sources the draft actually cites; the warning considers those (or all it read when it cited none).
  const citedSources = sources.filter((s) => cited.includes(s.n));
  const warning = phase !== "review" ? null
    : citedSources.length ? sensitivityWarning(citedSources, pageVisibility)
    : addsNew ? sensitivityWarning(sources, pageVisibility, { cited: false }) : null;
  const ease = [0.22, 1, 0.36, 1] as const;

  return (
    <>
      <AnimatePresence initial={false}>
        {phase !== "closed" && (
          <motion.section key="cowrite" aria-labelledby={`${id}-h`}
            initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 12 }} transition={{ duration: 0.2, ease }}
            className="sticky bottom-[calc(5.5rem+env(safe-area-inset-bottom))] z-30 mx-3 mb-3 rounded-lg bg-surface p-3 font-sans shadow-float sm:mx-6 sm:p-4 lg:bottom-4">
            {phase === "composing" && (
              <form onSubmit={(e) => void start(e)} onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); close(); editor.commands.focus(); } }}>
                <div className="flex items-center justify-between gap-3">
                  <h2 id={`${id}-h`} className="flex items-center gap-2 text-sm font-semibold"><Sparkles aria-hidden className="size-4 text-accent" />Ask the assistant to write</h2>
                  <IconButton type="button" label="Close" onClick={close}><X aria-hidden className="size-4" /></IconButton>
                </div>
                <label htmlFor={`${id}-ask`} className="sr-only">What should the assistant write?</label>
                <textarea id={`${id}-ask`} ref={inputRef} rows={2} value={instruction} maxLength={2000}
                  onChange={(e) => { setInstruction(e.target.value); if (error) setError(null); }}
                  onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey || !e.shiftKey)) { e.preventDefault(); void start(); } }}
                  placeholder={`For example: ${EXAMPLES[mode][0]}`}
                  // The UI kit's Textarea look; a plain element because the composer needs a ref for focus.
                  className="mt-2 w-full resize-none rounded-md bg-surface px-3 py-2 text-[15px] leading-relaxed text-fg ring-1 ring-inset ring-line transition-shadow placeholder:text-muted/80 hover:ring-muted/40 focus:outline-none focus:ring-2 focus:ring-accent" />
                {!instruction.trim() && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {EXAMPLES[mode].map((x) => (
                      <button key={x} type="button" onClick={() => { setInstruction(x); inputRef.current?.focus(); }}
                        className="rounded-full bg-surface-2 px-2.5 py-1 text-left text-xs text-muted transition-colors hover:text-fg">{x}</button>
                    ))}
                  </div>
                )}
                <fieldset className="mt-3">
                  <legend className="sr-only">Where to write</legend>
                  <div className="grid grid-cols-3 gap-0.5 rounded-md bg-surface-2 p-0.5 sm:inline-flex">
                    {MODE_OPTIONS.map((o) => {
                      const disabled = o.mode === "rewrite" && !hasSelection;
                      return (
                        <label key={o.mode} title={disabled ? "Select some text in the page first" : undefined}
                          className={clsx("relative cursor-pointer whitespace-nowrap rounded-[5px] px-2.5 py-1 text-center text-sm transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent",
                            mode === o.mode && !disabled ? "bg-surface text-fg shadow-[0_1px_0_var(--line)]" : "text-muted hover:text-fg", disabled && "cursor-not-allowed opacity-45 hover:text-muted")}>
                          <input type="radio" name={`${id}-mode`} value={o.mode} checked={mode === o.mode} disabled={disabled} onChange={() => setMode(o.mode)} className="sr-only" />
                          <span className="sm:hidden">{o.short}</span><span className="hidden sm:inline">{o.label}</span>
                        </label>
                      );
                    })}
                  </div>
                </fieldset>
                <div className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                  <p className="min-w-0 flex-1 text-xs text-muted">It reads only what you can see in this graph and cites it. Nothing is saved until you accept.</p>
                  <Button type="submit" size="sm"><Sparkles aria-hidden className="size-3.5" />Write</Button>
                </div>
                {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
              </form>
            )}

            {phase === "writing" && (
              <div className="flex flex-wrap items-center justify-between gap-3" aria-live="polite">
                <div className="flex min-w-0 items-center gap-3">
                  <Badge tone="accent"><span aria-hidden className="size-1.5 rounded-full bg-accent" />Assistant is writing</Badge>
                  <h2 id={`${id}-h`} className="sr-only">The assistant is writing in this page</h2>
                  <p className="min-w-0 truncate text-sm text-muted">
                    {words > 0 ? `${words} ${words === 1 ? "word" : "words"} so far.` : sources.length ? `Read ${sources.length} ${sources.length === 1 ? "item" : "items"} from your graph.` : "Looking through your graph…"}
                    <span className="hidden sm:inline"> Keep editing elsewhere if you like.</span>
                  </p>
                </div>
                <Button size="sm" variant="secondary" onClick={stop}><Square aria-hidden className="size-3 fill-current" />Stop</Button>
              </div>
            )}

            {phase === "review" && (
              <div>
                <h2 id={`${id}-h`} className="text-sm font-semibold">Keep what the assistant wrote?</h2>
                <p className="mt-0.5 text-sm text-muted">
                  It wrote {words} {words === 1 ? "word" : "words"}{citedSources.length ? <> from {citedSources.length} {citedSources.length === 1 ? "source" : "sources"}</> : sources.length ? ", without citing a source" : ", with nothing from your graph to go on"}. The highlighted text is only a draft until you accept it.
                  {touched && " Undo also removes your changes inside the highlighted text."}
                </p>
                {citedSources.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {citedSources.slice(0, 5).map((s) => <CitationChip key={s.n} n={s.n} title={s.title} detail={s.what} href={citeHref(s)} />)}
                    {citedSources.length > 5 && <span className="self-center text-xs text-muted">and {citedSources.length - 5} more</span>}
                  </div>
                )}
                {warning && (
                  <p className="mt-3 flex items-start gap-2 rounded-md bg-warn-tint px-3 py-2 text-sm text-warn" role="note">
                    <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />{warning}
                  </p>
                )}
                {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Button size="sm" onClick={() => void accept()} disabled={busy}>{busy ? "Saving…" : "Accept"}</Button>
                  <Button size="sm" variant="secondary" onClick={undo} disabled={busy}>Undo</Button>
                  <Button size="sm" variant="ghost" onClick={tryAgain} disabled={busy}>Ask differently</Button>
                </div>
              </div>
            )}
          </motion.section>
        )}
      </AnimatePresence>
      <p role="status" aria-live="polite" className={clsx("fixed bottom-24 left-1/2 z-40 -translate-x-1/2 rounded-lg bg-fg px-4 py-2.5 font-sans text-sm text-bg shadow-float lg:bottom-8", !notice && "sr-only")}>{notice}</p>
    </>
  );
}

/** The page as autosave should store it: without a draft that hasn't been accepted yet. */
export function savedDocOf(editor: Editor): Doc {
  const s = getCowrite(editor.state);
  return (s.edit ? docWithoutEdit(editor.state.doc, s.edit).toJSON() : editor.getJSON()) as Doc;
}
