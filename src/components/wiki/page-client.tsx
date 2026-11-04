"use client";
/**
 * A wiki page: calm read view, Edit to switch to the editor in place. While editing, changes autosave 1.5 s after
 * typing stops, with an optimistic version check — if someone else saved first, the writer chooses between their
 * version and overwriting it.
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Editor } from "@tiptap/react";
import { clsx } from "clsx";
import { AlertTriangle, ArrowLeft, Check, CloudOff, History, LoaderCircle, Lock, Pencil, Sparkles, Trash2, Users, Waypoints } from "lucide-react";
import { Button, buttonClass, Select } from "@/components/ui";
import type { Doc } from "@/lib/wiki/doc";
import { useLocale, useT, useTimeZone } from "@/lib/i18n/client";
import type { TFn } from "@/lib/i18n/core";
import { VISIBILITIES, type Visibility } from "@/lib/wiki/labels";
import { visibilityHint, visibilityLabel, visibilitySentence } from "./copy";
import type { AcceptInfo, AcceptResult } from "./cowrite/cowrite-panel";
import { clearCowrite } from "./cowrite/extension";
import { DocView, isEmptyDoc, type MentionInfo } from "./doc-view";
import { makeWhen } from "./when";
import { WikiEditor } from "./wiki-editor";

export type ClientPage = {
  id: string; slug: string; title: string; content: Doc; visibility: Visibility; version: number;
  ownerName: string; isOwner: boolean; updatedAt: string; updatedByName: string | null; nodeId?: string | null;
  can: { edit: boolean; delete: boolean; changeVisibility: boolean };
};

type SaveState =
  | { kind: "saved" }
  | { kind: "saving" }
  | { kind: "error"; message: string }
  | { kind: "conflict"; theirs: { version: number; title: string; content: Doc; updatedByName: string | null }; message: string };

const AUTOSAVE_MS = 1500;

function When({ iso }: { iso: string }) {
  const t = useT();
  const locale = useLocale();
  const timeZone = useTimeZone();
  const when = makeWhen({ t, locale, timeZone });
  const d = new Date(iso);
  return <time dateTime={iso} title={when.full(d)} suppressHydrationWarning>{when.sentence(d)}</time>;
}

export function WikiPageClient({ initial, startEditing, startAsking = false, mentions, family = false, children }: {
  initial: ClientPage; startEditing: boolean;
  /** A family graph: visibility reads as parents / whole family, examples are family ones. */
  family?: boolean;
  /** Open the editor with "Ask the assistant to write" ready (from ?assist=1). */
  startAsking?: boolean;
  /** Type and access for each mentioned node, so mentions render as the right chip. */
  mentions?: { id: string; type: string; readable: boolean }[];
  /** The quiet side column: links and mentions. */
  children?: React.ReactNode;
}) {
  const router = useRouter();
  const t = useT();
  const tRef = useRef<TFn>(t);
  tRef.current = t;
  const [page, setPage] = useState(initial);
  const [editing, setEditing] = useState(startEditing && initial.can.edit);
  const [title, setTitle] = useState(initial.title);
  const [state, setState] = useState<SaveState>({ kind: "saved" });
  const [visBusy, setVisBusy] = useState(false);
  const [visError, setVisError] = useState<string | null>(null);
  const [askSignal, setAskSignal] = useState(startAsking && startEditing && initial.can.edit ? 1 : 0);
  const [draftPending, setDraftPending] = useState(false);
  const draftRef = useRef(false);
  const titleId = useId();
  const mentionInfo: MentionInfo = new Map((mentions ?? []).map((m) => [m.id, { type: m.type, readable: m.readable }]));

  // Mutable save machinery (refs so the debounced callbacks always see the latest values).
  const doc = useRef<Doc>(initial.content);
  const titleRef = useRef(initial.title);
  const version = useRef(initial.version);
  const edits = useRef(0); // bumps on every local change
  const savedEdits = useRef(0); // the edit count the server has
  const inFlight = useRef(false);
  const again = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editorRef = useRef<Editor | null>(null);
  const conflictRef = useRef<HTMLDialogElement>(null);

  const dirty = () => edits.current !== savedEdits.current;

  const save = useCallback(async (force = false): Promise<boolean> => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    if (inFlight.current) { again.current = true; return false; }
    if (!dirty() && !force) { setState({ kind: "saved" }); return true; }
    inFlight.current = true;
    const snapshot = edits.current;
    setState({ kind: "saving" });
    try {
      const res = await fetch(`/api/wiki/${encodeURIComponent(page.slug)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: version.current, title: titleRef.current, content: doc.current, ...(force ? { force: true } : {}) }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 409 && data.current) {
        setState({ kind: "conflict", theirs: data.current, message: data.error ?? tRef.current("wiki.page.conflict.fallback") });
        return false;
      }
      if (!res.ok) {
        setState({ kind: "error", message: data.error ?? tRef.current(res.status === 401 ? "wiki.page.save.signedOut" : "wiki.page.save.failed") });
        return false;
      }
      if (data.page) {
        version.current = data.page.version;
        setPage((p) => ({ ...p, version: data.page.version, updatedAt: data.page.updatedAt, updatedByName: data.page.updatedByName, title: data.page.title }));
      }
      savedEdits.current = snapshot;
      if (dirty()) again.current = true;
      setState({ kind: dirty() ? "saving" : "saved" });
      return true;
    } catch {
      setState({ kind: "error", message: tRef.current("wiki.page.save.offline") });
      return false;
    } finally {
      inFlight.current = false;
      // Typing continued during the request: save the rest. After a failure, wait for Retry or the next keystroke.
      const followUp = again.current;
      again.current = false;
      if (followUp && dirty() && !timer.current) timer.current = setTimeout(() => void save(), 300);
    }
  }, [page.slug]);

  const changed = useCallback(() => {
    edits.current++;
    setState((s) => (s.kind === "conflict" ? s : { kind: "saving" }));
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(), AUTOSAVE_MS);
  }, [save]);

  const onDocChange = useCallback((d: Doc) => { doc.current = d; changed(); }, [changed]);
  const onReady = useCallback((e: Editor) => { editorRef.current = e; }, []);

  // Warn before leaving with unsaved text.
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => { if (dirty() || inFlight.current || draftRef.current) { e.preventDefault(); e.returnValue = ""; } };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, []);

  // Save immediately when the tab is hidden (phone lock, tab switch).
  useEffect(() => {
    const h = () => { if (document.visibilityState === "hidden" && dirty()) void save(); };
    document.addEventListener("visibilitychange", h);
    return () => document.removeEventListener("visibilitychange", h);
  }, [save]);

  useEffect(() => {
    const d = conflictRef.current;
    if (!d) return;
    if (state.kind === "conflict" && !d.open) d.showModal();
    if (state.kind !== "conflict" && d.open) d.close();
  }, [state]);

  const loadTheirs = () => {
    if (state.kind !== "conflict") return;
    const t = state.theirs;
    version.current = t.version;
    doc.current = t.content;
    titleRef.current = t.title;
    setTitle(t.title);
    if (editorRef.current) clearCowrite(editorRef.current);
    editorRef.current?.commands.setContent(t.content, { emitUpdate: false });
    savedEdits.current = edits.current;
    setPage((p) => ({ ...p, version: t.version, title: t.title, content: t.content }));
    setState({ kind: "saved" });
  };

  const overwrite = () => {
    if (state.kind !== "conflict") return;
    version.current = state.theirs.version;
    setState({ kind: "saving" });
    void save(true);
  };

  /** Wait for any save in progress, then save what's left. True when the server has everything. */
  const flush = async (): Promise<boolean> => {
    for (let i = 0; inFlight.current && i < 100; i++) await new Promise((r) => setTimeout(r, 100));
    if (dirty()) await save();
    return !dirty() && !inFlight.current;
  };

  /**
   * Keep the assistant's draft: first save the person's own edits (autosave never includes the draft), then save the
   * whole page as the assistant's revision, so history shows exactly what each of them changed.
   */
  const acceptDraft = async (fullDoc: Doc, info: AcceptInfo): Promise<AcceptResult> => {
    if (!(await flush())) return { ok: false, error: t("wiki.page.accept.ownFirst") };
    try {
      const res = await fetch(`/api/wiki/${encodeURIComponent(page.slug)}/cowrite/accept`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: version.current, content: fullDoc, ...info }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        return { ok: false, error: res.status === 409
          ? t("wiki.page.accept.conflict", { error: data.error ?? t("wiki.page.accept.someoneSaved") })
          : data.error ?? t("wiki.page.accept.failed") };
      }
      version.current = data.page.version;
      doc.current = fullDoc;
      savedEdits.current = edits.current;
      setPage((p) => ({ ...p, version: data.page.version, updatedAt: data.page.updatedAt, updatedByName: data.page.updatedByName }));
      setState({ kind: "saved" });
      return { ok: true };
    } catch {
      return { ok: false, error: t("wiki.page.accept.offline") };
    }
  };

  const onDraftPending = useCallback((p: boolean) => { draftRef.current = p; setDraftPending(p); }, []);

  const done = async () => {
    if (draftRef.current) return; // the panel asks to accept or undo first
    if (!(await flush())) return; // the indicator shows why (error or conflict)
    setPage((p) => ({ ...p, content: doc.current, title: titleRef.current }));
    setEditing(false);
    router.replace(`/wiki/${encodeURIComponent(page.slug)}`, { scroll: false }); // fresh backlinks and mentions; drops ?edit=1
  };

  const changeVisibility = async (v: Visibility) => {
    setVisBusy(true); setVisError(null);
    try {
      const res = await fetch(`/api/wiki/${encodeURIComponent(page.slug)}`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ visibility: v }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? t("wiki.page.visFailed"));
      setPage((p) => ({ ...p, visibility: v }));
    } catch (e) {
      setVisError(e instanceof Error ? e.message : t("wiki.page.visFailed"));
    } finally {
      setVisBusy(false);
    }
  };

  const beginEditing = () => { setTitle(page.title); titleRef.current = page.title; doc.current = page.content; setEditing(true); };
  const beginAsking = () => { beginEditing(); setAskSignal((n) => n + 1); };
  const historyHref = `/wiki/${encodeURIComponent(page.slug)}/history`;
  const VisIcon = page.visibility === "private" ? Lock : Users;

  const byline = (
    <p className="mt-3 text-sm text-muted">
      {t("wiki.page.editedBy", { name: page.updatedByName ?? t("wiki.page.someone") })} <When iso={page.updatedAt} />.
      {!page.isOwner && <> {t("wiki.page.startedBy", { name: page.ownerName })}</>}
    </p>
  );

  return (
    <div className="grid gap-x-12 gap-y-10 xl:grid-cols-[minmax(0,1fr)_16rem]">
      <div className="min-w-0">
        {/* Above the sheet: the way back, and what you can do with the page. */}
        <div className="mb-3 flex min-h-9 items-center justify-between gap-3">
          <Link href="/wiki" className="-ml-2 inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-sm text-muted transition-colors hover:bg-surface-2 hover:text-fg">
            <ArrowLeft aria-hidden className="size-4" />{t("wiki.title")}
          </Link>
          {!editing && (
            <div className="flex items-center gap-1.5">
              <Link href={historyHref} className={buttonClass("ghost", "sm")}><History aria-hidden className="size-4" />{t("wiki.page.history")}</Link>
              {page.can.edit && <Button size="sm" variant="ghost" onClick={beginAsking}><Sparkles aria-hidden className="size-4 text-accent" /><span className="hidden sm:inline">{t("wiki.page.ask")}</span><span className="sm:hidden">{t("wiki.page.askShort")}</span></Button>}
              {page.can.edit && <Button size="sm" onClick={beginEditing}><Pencil aria-hidden className="size-3.5" />{t("wiki.page.edit")}</Button>}
            </div>
          )}
        </div>

        <article className={clsx("rounded-lg bg-surface", !editing && "px-5 pb-14 pt-8 sm:px-12 sm:pt-12 lg:px-16")} aria-labelledby={editing ? undefined : `${titleId}-h`}>
          {editing ? (
            <WikiEditor pageId={page.id} pageVisibility={page.visibility} family={family} initialContent={doc.current} onChange={onDocChange} onReady={onReady} labelledBy={titleId}
              cowrite={{ slug: page.slug, openSignal: askSignal, onAccept: acceptDraft, onPendingChange: onDraftPending }}
              toolbarEnd={<>
                <SaveIndicator state={state} onRetry={() => void save()} />
                <Button size="sm" onClick={() => void done()} disabled={state.kind === "conflict" || draftPending}
                  title={draftPending ? t("wiki.page.draftFirst") : undefined}>{t("wiki.page.done")}</Button>
              </>}>
              <label htmlFor={titleId} className="sr-only">{t("wiki.page.titleLabel")}</label>
              <input id={titleId} value={title} maxLength={200} placeholder={t("wiki.newPage.untitled")}
                onChange={(e) => { setTitle(e.target.value); if (e.target.value.trim()) { titleRef.current = e.target.value; changed(); } }}
                onKeyDown={(e) => { if (e.key === "Enter" || (e.key === "ArrowDown" && e.currentTarget.selectionStart === e.currentTarget.value.length)) { e.preventDefault(); editorRef.current?.commands.focus("start"); } }}
                className="block w-full max-w-[68ch] bg-transparent p-0 text-[28px]/[1.2] font-semibold tracking-[-0.02em] text-fg caret-accent outline-none placeholder:text-muted/60" style={{ outline: "none" }} />
              {!title.trim()
                ? <p className="mt-3 text-sm text-warn" role="alert">{t("wiki.page.needTitle")}</p>
                : byline}
            </WikiEditor>
          ) : (
            <>
              <h1 id={`${titleId}-h`} className="max-w-[68ch] break-words text-[28px]/[1.2] font-semibold tracking-[-0.02em]">{page.title}</h1>
              {byline}
              {isEmptyDoc(page.content) ? (
                <div className="mt-8 max-w-[68ch] font-read text-[17px] leading-[1.75] text-muted">
                  <p>{t("wiki.page.empty")}</p>
                  {page.can.edit && (
                    <>
                      <p className="mt-1">{t("wiki.page.emptyHint")}</p>
                      <div className="mt-5 flex flex-wrap gap-2 font-sans">
                        <Button variant="secondary" onClick={beginEditing}><Pencil aria-hidden className="size-3.5" />{t("wiki.page.startWriting")}</Button>
                        <Button variant="ghost" onClick={beginAsking}><Sparkles aria-hidden className="size-4 text-accent" />{t("wiki.page.askDraft")}</Button>
                      </div>
                    </>
                  )}
                </div>
              ) : (
                <DocView doc={page.content} mentions={mentionInfo} className="mt-8" />
              )}
            </>
          )}
        </article>

        <dialog ref={conflictRef} aria-labelledby={`${titleId}-conflict`} onCancel={(e) => e.preventDefault()}
          className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-lg bg-surface p-6 text-fg shadow-float backdrop:bg-fg/30">
          <h2 id={`${titleId}-conflict`} className="flex items-center gap-2 text-lg font-semibold"><AlertTriangle aria-hidden className="size-5 text-warn" />{t("wiki.page.conflict.title")}</h2>
          <p className="mt-2 text-sm text-muted">{state.kind === "conflict" ? state.message : null} {t("wiki.page.conflict.choose")}</p>
          <dl className="mt-4 space-y-3 text-sm">
            <div><dt className="font-medium">{t("wiki.page.conflict.loadTheirs")}</dt><dd className="text-muted">{t("wiki.page.conflict.loadTheirsHint")}</dd></div>
            <div><dt className="font-medium">{t("wiki.page.conflict.keepMine")}</dt><dd className="text-muted">{t("wiki.page.conflict.keepMineHint")}</dd></div>
          </dl>
          <div className="mt-6 flex flex-wrap justify-end gap-2">
            <Button variant="secondary" onClick={loadTheirs}>{t("wiki.page.conflict.loadTheirs")}</Button>
            <Button onClick={overwrite}>{t("wiki.page.conflict.keepMine")}</Button>
          </div>
        </dialog>
      </div>

      {/* The quiet column: who can see it, what links here, who is mentioned. */}
      <aside className="space-y-8 text-sm xl:pt-12" aria-label={t("wiki.page.about")}>
        <section aria-labelledby={`${titleId}-vis-h`}>
          <h2 id={`${titleId}-vis-h`} className="mb-2 font-semibold">{t("wiki.page.whoCanSee")}</h2>
          {page.can.changeVisibility ? (
            <>
              <label htmlFor={`${titleId}-vis`} className="sr-only">{t("wiki.page.whoCanSee")}</label>
              <Select id={`${titleId}-vis`} value={page.visibility} disabled={visBusy} aria-describedby={`${titleId}-vis-hint`} className="h-8 text-sm"
                onChange={(e) => void changeVisibility(e.target.value as Visibility)}>
                {VISIBILITIES.map((v) => <option key={v} value={v}>{visibilityLabel(t, v, family)}</option>)}
              </Select>
              <p id={`${titleId}-vis-hint`} className="mt-2 text-muted">{visibilityHint(t, page.visibility, family)}</p>
              {visError && <p role="alert" className="mt-2 text-danger">{visError}</p>}
            </>
          ) : (
            <p className="flex items-start gap-2 text-muted"><VisIcon aria-hidden className="mt-0.5 size-4 shrink-0" />{visibilitySentence(t, page.visibility, family)}</p>
          )}
        </section>
        {children}
        <section className="space-y-1" aria-label={t("wiki.page.more")}>
          <Link href={historyHref} className="-ml-2 flex h-8 items-center gap-2 rounded-md px-2 text-muted transition-colors hover:bg-surface-2 hover:text-fg">
            <History aria-hidden className="size-4" />{t("wiki.page.everyVersion")}
          </Link>
          {page.nodeId && (
            <Link href={`/node/${page.nodeId}`} className="-ml-2 flex h-8 items-center gap-2 rounded-md px-2 text-muted transition-colors hover:bg-surface-2 hover:text-fg">
              <Waypoints aria-hidden className="size-4" />{t("wiki.page.showInGraph")}
            </Link>
          )}
          {page.can.delete && <DeleteButton slug={page.slug} title={page.title} />}
        </section>
      </aside>
    </div>
  );
}

function SaveIndicator({ state, onRetry }: { state: SaveState; onRetry: () => void }) {
  const t = useT();
  return (
    <span role="status" aria-live="polite" className="inline-flex items-center gap-1.5 whitespace-nowrap text-sm">
      {state.kind === "saved" && <><Check aria-hidden className="size-4 text-muted" /><span className="text-muted">{t("wiki.page.save.saved")}</span></>}
      {state.kind === "saving" && <><LoaderCircle aria-hidden className="size-4 animate-spin text-muted" /><span className="text-muted">{t("wiki.page.save.saving")}</span></>}
      {state.kind === "conflict" && <><AlertTriangle aria-hidden className="size-4 text-warn" /><span className="text-warn">{t("wiki.page.save.notSaved")}<span className="hidden sm:inline">{t("wiki.page.save.someoneElse")}</span></span></>}
      {state.kind === "error" && (
        <>
          <CloudOff aria-hidden className="size-4 text-danger" />
          <span className="hidden text-danger sm:inline" title={state.message}>{t("wiki.page.save.notSaved")}</span>
          <button type="button" onClick={onRetry} className="rounded font-medium text-danger underline underline-offset-2">{t("wiki.page.save.retry")}</button>
          <span className="sr-only">{state.message}</span>
        </>
      )}
    </span>
  );
}

function DeleteButton({ slug, title }: { slug: string; title: string }) {
  const router = useRouter();
  const t = useT();
  const ref = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const remove = async () => {
    setBusy(true); setError(null);
    try {
      const res = await fetch(`/api/wiki/${encodeURIComponent(slug)}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? t("wiki.page.delete.failed"));
      ref.current?.close();
      router.push("/wiki");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("wiki.page.delete.failed"));
      setBusy(false);
    }
  };
  return (
    <>
      <button type="button" className="-ml-2 flex h-8 items-center gap-2 rounded-md px-2 text-muted transition-colors hover:bg-danger-tint hover:text-danger" onClick={() => ref.current?.showModal()}>
        <Trash2 aria-hidden className="size-4" />{t("wiki.page.delete.button")}
      </button>
      <dialog ref={ref} aria-labelledby={id}
        className="m-auto w-[min(28rem,calc(100vw-2rem))] rounded-lg bg-surface p-6 text-fg shadow-float backdrop:bg-fg/30">
        <h2 id={id} className="text-lg font-semibold">{t("wiki.page.delete.title", { title })}</h2>
        <p className="mt-2 text-sm text-muted">{t("wiki.page.delete.body")}</p>
        {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => ref.current?.close()} disabled={busy}>{t("wiki.page.delete.cancel")}</Button>
          <Button variant="danger" onClick={() => void remove()} disabled={busy}>{busy ? t("wiki.page.delete.deleting") : t("wiki.page.delete.button")}</Button>
        </div>
      </dialog>
    </>
  );
}
