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
import { format, isThisYear } from "date-fns";
import { AlertTriangle, Check, History, LoaderCircle, Pencil, Trash2 } from "lucide-react";
import { Button, Select } from "@/components/ui";
import type { Doc } from "@/lib/wiki/doc";
import { VISIBILITIES, VISIBILITY_HINT, VISIBILITY_LABEL, type Visibility } from "@/lib/wiki/labels";
import { DocView, isEmptyDoc } from "./doc-view";
import { WikiEditor } from "./wiki-editor";

export type ClientPage = {
  id: string; slug: string; title: string; content: Doc; visibility: Visibility; version: number;
  ownerName: string; isOwner: boolean; updatedAt: string; updatedByName: string | null;
  can: { edit: boolean; delete: boolean; changeVisibility: boolean };
};

type SaveState =
  | { kind: "saved" }
  | { kind: "saving" }
  | { kind: "error"; message: string }
  | { kind: "conflict"; theirs: { version: number; title: string; content: Doc; updatedByName: string | null }; message: string };

const AUTOSAVE_MS = 1500;

/** Who can see a page, as a sentence for the line under the title. */
const VISIBILITY_SENTENCE: Partial<Record<Visibility, string>> = {
  private: "Only you can see it",
  parents: "Parents can see it",
  household: "The whole family can see it",
};

function When({ iso }: { iso: string }) {
  const d = new Date(iso);
  return <time dateTime={iso} title={d.toLocaleString()} suppressHydrationWarning>{format(d, isThisYear(d) ? "EEE d MMM 'at' HH:mm" : "d MMM yyyy")}</time>;
}

export function WikiPageClient({ initial, startEditing, children }: { initial: ClientPage; startEditing: boolean; children?: React.ReactNode }) {
  const router = useRouter();
  const [page, setPage] = useState(initial);
  const [editing, setEditing] = useState(startEditing && initial.can.edit);
  const [title, setTitle] = useState(initial.title);
  const [state, setState] = useState<SaveState>({ kind: "saved" });
  const [visBusy, setVisBusy] = useState(false);
  const [visError, setVisError] = useState<string | null>(null);
  const titleId = useId();

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
        setState({ kind: "conflict", theirs: data.current, message: data.error ?? "Someone else changed this page while you were editing it." });
        return false;
      }
      if (!res.ok) {
        setState({ kind: "error", message: data.error ?? (res.status === 401 ? "You've been signed out. Sign in again in another tab, then retry." : "Couldn't save.") });
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
      setState({ kind: "error", message: "You seem to be offline. Your text is still here." });
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
    const h = (e: BeforeUnloadEvent) => { if (dirty() || inFlight.current) { e.preventDefault(); e.returnValue = ""; } };
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

  const done = async () => {
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
      if (!res.ok) throw new Error(data.error ?? "Couldn't change who can see this page.");
      setPage((p) => ({ ...p, visibility: v }));
    } catch (e) {
      setVisError(e instanceof Error ? e.message : "Couldn't change who can see this page.");
    } finally {
      setVisBusy(false);
    }
  };

  const lastEdited = (
    <>Edited <When iso={page.updatedAt} />{page.updatedByName ? <> by {page.updatedByName}</> : null}</>
  );
  const seenBy = VISIBILITY_SENTENCE[page.visibility] ?? `Visible to ${VISIBILITY_LABEL[page.visibility]}`;
  const meta = (
    <>{lastEdited}. {seenBy}.{!page.isOwner && <> Started by {page.ownerName}.</>}</>
  );

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_16rem]">
      <article className="min-w-0">
        <nav aria-label="Breadcrumb" className="mb-4 text-sm text-muted">
          <Link href="/wiki" className="hover:text-fg hover:underline">Wiki</Link>
          <span aria-hidden> / </span>
          <span className="text-fg">{title || "Untitled"}</span>
        </nav>

        <header className="mb-2 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 flex-1">
            {editing ? (
              <>
                <label htmlFor={titleId} className="sr-only">Page title</label>
                <input id={titleId} value={title} maxLength={200} placeholder="Page title"
                  onChange={(e) => { setTitle(e.target.value); if (e.target.value.trim()) { titleRef.current = e.target.value; changed(); } }}
                  className="w-full max-w-[70ch] rounded-md border border-transparent bg-transparent px-0 py-0.5 text-[28px]/[1.15] font-semibold tracking-[-0.02em] outline-none placeholder:text-muted focus:border-line focus:px-2" />
              </>
            ) : (
              <h1 className="break-words text-[28px]/[1.15] font-semibold tracking-[-0.02em]">{page.title}</h1>
            )}
            <p className="mt-2 text-sm text-muted">{meta}</p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {editing && <SaveIndicator state={state} onRetry={() => void save()} />}
            <Link href={`/wiki/${encodeURIComponent(page.slug)}/history`}
              className="inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium text-muted hover:bg-surface-2 hover:text-fg">
              <History aria-hidden className="size-4" />History
            </Link>
            {page.can.edit && (editing
              ? <Button onClick={() => void done()} disabled={state.kind === "conflict"}><Check aria-hidden className="size-4" />Done</Button>
              : <Button onClick={() => { setTitle(page.title); titleRef.current = page.title; doc.current = page.content; setEditing(true); }}><Pencil aria-hidden className="size-4" />Edit</Button>)}
          </div>
        </header>

        {editing && !title.trim() && <p className="mb-2 text-sm text-warn" role="alert">A page needs a title. We&apos;ll keep the old one until you add a new one.</p>}

        {editing ? (
          <WikiEditor pageId={page.id} pageVisibility={page.visibility} initialContent={doc.current} onChange={onDocChange} onReady={onReady} labelledBy={titleId} />
        ) : isEmptyDoc(page.content) ? (
          <div className="mt-6 max-w-[70ch] rounded-lg border border-dashed border-line p-6 text-sm text-muted">
            <p className="font-medium text-fg">This page is empty.</p>
            {page.can.edit
              ? <p className="mt-1">Click <span className="font-medium">Edit</span> to start writing. Type @ to mention a person, place or event, and [[ to link another page.</p>
              : <p className="mt-1">Nothing has been written here yet.</p>}
          </div>
        ) : (
          <DocView doc={page.content} className="mt-4" />
        )}

        <dialog ref={conflictRef} aria-labelledby={`${titleId}-conflict`} onCancel={(e) => e.preventDefault()}
          className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-lg border border-line bg-surface p-5 text-fg shadow-xl backdrop:bg-black/40">
          <h2 id={`${titleId}-conflict`} className="flex items-center gap-2 text-lg font-semibold"><AlertTriangle aria-hidden className="size-5 text-warn" />This page changed while you were editing</h2>
          <p className="mt-2 text-sm text-muted">{state.kind === "conflict" ? state.message : null} Choose which version to keep.</p>
          <ul className="mt-3 space-y-2 text-sm">
            <li><span className="font-medium">Load their version</span> — your unsaved changes since your last save are dropped.</li>
            <li><span className="font-medium">Keep mine</span> — your version replaces theirs. Theirs stays in the page history, so nothing is lost for good.</li>
          </ul>
          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <Button variant="secondary" onClick={loadTheirs}>Load their version</Button>
            <Button onClick={overwrite}>Keep mine</Button>
          </div>
        </dialog>
      </article>

      <aside className="space-y-8 lg:pt-10" aria-label="About this page">
        {children}
        {(page.can.changeVisibility || page.can.delete) && (
          <section className="space-y-3">
            <h2 className="text-sm font-semibold">Page settings</h2>
            {page.can.changeVisibility && (
              <div>
                <label htmlFor={`${titleId}-vis`} className="mb-1 block text-sm">Who can see this</label>
                <Select id={`${titleId}-vis`} value={page.visibility} disabled={visBusy} aria-describedby={`${titleId}-vis-hint`}
                  onChange={(e) => void changeVisibility(e.target.value as Visibility)}>
                  {VISIBILITIES.map((v) => <option key={v} value={v}>{VISIBILITY_LABEL[v]}</option>)}
                </Select>
                <p id={`${titleId}-vis-hint`} className="mt-1 text-xs text-muted">{VISIBILITY_HINT[page.visibility]}</p>
                {visError && <p role="alert" className="mt-1 text-xs text-danger">{visError}</p>}
              </div>
            )}
            {page.can.delete && <DeleteButton slug={page.slug} title={page.title} />}
          </section>
        )}
      </aside>
    </div>
  );
}

function SaveIndicator({ state, onRetry }: { state: SaveState; onRetry: () => void }) {
  return (
    <span role="status" aria-live="polite" className="inline-flex items-center gap-1.5 text-sm">
      {state.kind === "saved" && <><Check aria-hidden className="size-4 text-accent" /><span className="text-muted">Saved</span></>}
      {state.kind === "saving" && <><LoaderCircle aria-hidden className="size-4 animate-spin text-muted" /><span className="text-muted">Saving…</span></>}
      {state.kind === "conflict" && <><AlertTriangle aria-hidden className="size-4 text-warn" /><span className="text-warn">Not saved — someone else edited</span></>}
      {state.kind === "error" && (
        <>
          <AlertTriangle aria-hidden className="size-4 text-danger" />
          <span className="text-danger" title={state.message}>Couldn&apos;t save</span>
          <span aria-hidden className="text-muted">—</span>
          <button type="button" onClick={onRetry} className="font-medium text-accent underline underline-offset-2">Retry</button>
          <span className="sr-only">{state.message}</span>
        </>
      )}
    </span>
  );
}

function DeleteButton({ slug, title }: { slug: string; title: string }) {
  const router = useRouter();
  const ref = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const remove = async () => {
    setBusy(true); setError(null);
    try {
      const res = await fetch(`/api/wiki/${encodeURIComponent(slug)}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Couldn't delete the page.");
      ref.current?.close();
      router.push("/wiki");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't delete the page.");
      setBusy(false);
    }
  };
  return (
    <>
      <Button variant="ghost" className="px-0 text-danger hover:bg-transparent hover:text-danger hover:underline" onClick={() => ref.current?.showModal()}>
        <Trash2 aria-hidden className="size-4" />Delete page
      </Button>
      <dialog ref={ref} aria-labelledby={id}
        className="m-auto w-[min(28rem,calc(100vw-2rem))] rounded-lg border border-line bg-surface p-5 text-fg shadow-xl backdrop:bg-black/40">
        <h2 id={id} className="text-lg font-semibold">Delete “{title}”?</h2>
        <p className="mt-2 text-sm text-muted">The page and its whole history are removed for everyone. Links to it from other pages will stop working. This can&apos;t be undone.</p>
        {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => ref.current?.close()} disabled={busy}>Cancel</Button>
          <Button variant="danger" onClick={() => void remove()} disabled={busy}>{busy ? "Deleting…" : "Delete page"}</Button>
        </div>
      </dialog>
    </>
  );
}
