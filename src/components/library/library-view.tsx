"use client";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { clsx } from "clsx";
import { AnimatePresence, motion } from "motion/react";
import { Check, Folder, FolderInput, LayoutGrid, Lock, MessagesSquare, RefreshCw, Rows3, Search, ShieldAlert, X } from "lucide-react";
import { Avatar, Button, Input, Select, Tabs } from "@/components/ui";
import { RebuildButton } from "@/components/timeline/rebuild-button";
import type { LibraryType, SourceSummary } from "@/lib/ingest/library";
import { extensionLabel, isStuck, StatusPill, stepText, TypeIcon, type SourceStatus } from "./source-meta";
import { ReadingQueue } from "./reading-queue";
import { formatBytes, formatDay, formatDocDate, kindWord, senderName, visibilityLabel, type Lx } from "./i18n";
import { useLx } from "./use-lx";
import { UploadZone } from "./upload-zone";
import { DRAG_TYPE, findFolder, folderApi, trail, type FolderKey, type FolderTree, type FolderView, type SuggestionGroup } from "./folder-client";
import { DeleteFolderDialog, FolderSharingDialog, MoveFolderDialog, NameDialog, SaveTemplateDialog, TemplatesDialog } from "./folder-dialogs";
import { MoveToMenu } from "./folder-menu";
import { FolderBar, FolderSidebar, type FolderActions } from "./library-folders";
import { FolderSuggestions } from "./folder-suggestions";

/** folder: "" all files, "root" not in a folder, else a folder id. */
export type LibraryFilters = { type: LibraryType | ""; status: SourceStatus | ""; q: string; folder: FolderKey };
type List = { items: SourceSummary[]; total: number; dropped?: SourceSummary[] };

const KIND_FILTERS: { value: LibraryType | ""; key: string }[] = [
  { value: "", key: "all" },
  { value: "mail", key: "mail" },
  { value: "letter", key: "letter" },
  { value: "scan", key: "scan" },
  { value: "photo", key: "photo" },
  { value: "recording", key: "recording" },
  { value: "note", key: "note" },
];
const STATUS_OPTIONS: { value: SourceStatus | ""; key: string }[] = [
  { value: "", key: "any" },
  { value: "processing", key: "processing" },
  { value: "pending", key: "pending" },
  { value: "failed", key: "failed" },
  { value: "ready", key: "ready" },
];

const PAGE = 60;

function queryString(f: LibraryFilters, extra?: Record<string, string>) {
  const p = new URLSearchParams();
  if (f.folder) p.set("folder", f.folder);
  if (f.type) p.set("type", f.type);
  if (f.status) p.set("status", f.status);
  if (f.q.trim()) p.set("q", f.q.trim());
  for (const [k, v] of Object.entries(extra ?? {})) p.set(k, v);
  return p.toString();
}

const busy = (s: SourceSummary) => !!s.job || ((s.status === "pending" || s.status === "processing") && !isStuck(s.status, s.startedAt, s.createdAt, s.job));
const stuckOf = (s: SourceSummary) => isStuck(s.status, s.startedAt, s.createdAt, s.job);

type DialogState =
  | { kind: "name"; state: { kind: "create"; parent: FolderView | null } | { kind: "rename"; folder: FolderView } }
  | { kind: "delete"; folder: FolderView }
  | { kind: "sharing"; folder: FolderView }
  | { kind: "move"; folder: FolderView }
  | { kind: "templates" }
  | { kind: "saveTemplate" }
  | null;

/** What a file card or row needs to be selected, dragged and moved. */
export type ItemFolderProps = {
  folders: FolderView[];
  selected: Set<string>;
  selecting: boolean;
  toggle: (id: string) => void;
  dragIds: (id: string) => string[];
  move: (ids: string[], folderId: string | null) => void;
};

export function LibraryView({ initial, initialFilters, initialFolders, family = false, graphKind = "family" }: {
  initial: List; initialFilters: LibraryFilters; initialFolders: FolderTree; family?: boolean;
  /** New folders from a template are shared in graphs people share, private in a personal or practice graph. */
  graphKind?: string;
}) {
  const L = useLx(family);
  const { t } = L;
  const searchId = useId();
  const [filters, setFilters] = useState<LibraryFilters>(initialFilters);
  const [data, setData] = useState<List>(initial);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"grid" | "table">("grid");
  const [owner, setOwner] = useState<string>("");
  const [retrying, setRetrying] = useState<Set<string>>(new Set());
  const [watchingUploads, setWatchingUploads] = useState(false);
  const [queueKey, setQueueKey] = useState(0);
  const [tree, setTree] = useState<FolderTree>(initialFolders);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<DialogState>(null);
  const [notice, setNotice] = useState<{ text: string; tone: "ok" | "error" } | null>(null);
  const [groups, setGroups] = useState<SuggestionGroup[]>([]);
  const [suggesting, setSuggesting] = useState(false);
  const [deciding, setDeciding] = useState(false);
  const reqId = useRef(0);
  const tRef = useRef(t);
  tRef.current = t;
  const first = useRef(true);

  useEffect(() => {
    try {
      const saved = localStorage.getItem("library:view");
      if (saved === "grid" || saved === "table") setView(saved);
      else if (saved === "list") setView("table");
    } catch { /* storage unavailable */ }
  }, []);
  const changeView = (v: "grid" | "table") => {
    setView(v);
    try { localStorage.setItem("library:view", v); } catch { /* ignore */ }
  };

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [notice]);

  const load = useCallback(async (f: LibraryFilters, quiet = false, limit = PAGE) => {
    const my = ++reqId.current;
    if (!quiet) setLoading(true);
    try {
      const qs = queryString(f, limit !== PAGE ? { limit: String(Math.min(limit, 200)) } : undefined);
      const res = await fetch(`/api/library${qs ? `?${qs}` : ""}`, { cache: "no-store" });
      const body = await res.json().catch(() => ({}));
      if (my !== reqId.current) return;
      if (!res.ok) throw new Error(body.error ?? tRef.current("library.list.loadFailed"));
      setData(body);
      setError(null);
    } catch (e) {
      if (my === reqId.current && !quiet) setError(e instanceof Error ? e.message : tRef.current("library.list.loadFailed"));
    } finally {
      if (my === reqId.current) setLoading(false);
    }
  }, []);

  const loadFolders = useCallback(async () => {
    try { setTree(await folderApi<FolderTree>(L, "/api/library/folders")); } catch { /* keep the tree we have */ }
  }, [L]);
  const loadSuggestions = useCallback(async () => {
    try { setGroups((await folderApi<{ groups: SuggestionGroup[] }>(L, "/api/library/folders/suggestions")).groups); } catch { /* none shown */ }
  }, [L]);
  useEffect(() => { void loadSuggestions(); }, [loadSuggestions]);

  // Reload on filter change (debounced for typing) and keep the URL in step.
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    const t = setTimeout(() => {
      const qs = queryString(filters);
      window.history.replaceState(null, "", qs ? `?${qs}` : window.location.pathname);
      void load(filters);
    }, 250);
    return () => clearTimeout(t);
  }, [filters, load]);

  // Poll while anything on screen (or just uploaded) is being read; keep however many rows are showing.
  const shown = data.items.length;
  const active = data.items.some(busy) || watchingUploads;
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => void load(filters, true, Math.max(PAGE, shown)), 3000);
    return () => clearInterval(t);
  }, [active, filters, load, shown]);
  // When reading finishes, the counts and the suggestions change too.
  const wasActive = useRef(active);
  useEffect(() => {
    if (wasActive.current && !active) { void loadFolders(); void loadSuggestions(); }
    wasActive.current = active;
  }, [active, loadFolders, loadSuggestions]);

  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const qs = queryString(filters, { offset: String(data.items.length), limit: String(PAGE) });
      const res = await fetch(`/api/library?${qs}`, { cache: "no-store" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? t("library.list.moreFailed"));
      setData((d) => {
        const seen = new Set(d.items.map((s) => s.id));
        return { ...d, items: [...d.items, ...(body.items as SourceSummary[]).filter((s) => !seen.has(s.id))], total: body.total };
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : t("library.list.moreFailed"));
    } finally {
      setLoadingMore(false);
    }
  };

  const retry = async (id: string) => {
    setRetrying((s) => new Set(s).add(id));
    try {
      const res = await fetch(`/api/library/${id}/reprocess`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? t("library.list.retryFailed"));
      }
      await load(filters, true, Math.max(PAGE, shown));
      setQueueKey((k) => k + 1);
    } finally {
      setRetrying((s) => { const n = new Set(s); n.delete(id); return n; });
    }
  };

  // Who added what: the people behind the files on screen.
  const owners = useMemo(() => {
    const m = new Map<string, { id: string; name: string; count: number }>();
    for (const s of data.items) {
      const cur = m.get(s.ownerId) ?? { id: s.ownerId, name: s.ownerName ?? t("library.list.someone"), count: 0 };
      cur.count++;
      m.set(s.ownerId, cur);
    }
    return [...m.values()].sort((a, b) => b.count - a.count);
  }, [data.items, t]);
  const ownerActive = owner !== "" && owners.some((o) => o.id === owner);
  const items = ownerActive ? data.items.filter((s) => s.ownerId === owner) : data.items;

  const refreshAll = useCallback(() => {
    void load(filters, true, Math.max(PAGE, shown));
    void loadFolders();
    void loadSuggestions();
  }, [load, filters, shown, loadFolders, loadSuggestions]);

  // Uploads that turned out to be files already here are not listed, but the upload screen still asks about them.
  const byId = useMemo(() => new Map([...(data.dropped ?? []), ...data.items].map((s) => [s.id, s])), [data.items, data.dropped]);
  const statusOf = useCallback((id: string) => byId.get(id), [byId]);
  const onUploaded = useCallback(() => { void load(filters, true, Math.max(PAGE, shown)); void loadFolders(); setQueueKey((k) => k + 1); }, [load, filters, shown, loadFolders]);
  const onQueueSettled = useCallback(() => void load(filters, true, Math.max(PAGE, shown)), [load, filters, shown]);

  /* ── Folders ──────────────────────────────────────────────────────────────────────────────────────── */

  const folder = filters.folder && filters.folder !== "root" ? findFolder(tree.folders, filters.folder) : null;
  // A folder that went away (deleted, or no longer shared): back to everything.
  useEffect(() => {
    if (filters.folder && filters.folder !== "root" && !findFolder(tree.folders, filters.folder)) setFilters((f) => ({ ...f, folder: "" }));
  }, [tree.folders, filters.folder]);
  const searching = filters.q.trim() !== "";

  const openFolder = useCallback((key: FolderKey) => {
    setSelected(new Set());
    setOwner("");
    setFilters((f) => ({ ...f, folder: key, q: "" }));
  }, []);

  const moveFiles = useCallback(async (ids: string[], folderId: string | null) => {
    try {
      const r = await folderApi<{ moved: number; skipped: number }>(L, "/api/library/move", { sourceIds: ids, folderId });
      const name = folderId ? findFolder(tree.folders, folderId)?.name ?? "" : "";
      const parts = [r.moved ? (folderId ? t("library.folders.moved", { count: r.moved, name }) : t("library.folders.movedOut", { count: r.moved })) : null,
        r.skipped ? t("library.folders.skipped", { count: r.skipped }) : null].filter(Boolean);
      setNotice({ text: parts.join(" "), tone: r.moved ? "ok" : "error" });
      setSelected(new Set());
      refreshAll();
    } catch (e) {
      setNotice({ text: e instanceof Error ? e.message : t("library.folders.error.generic"), tone: "error" });
    }
  }, [L, t, tree.folders, refreshAll]);

  const runSuggestions = useCallback(async () => {
    setSuggesting(true);
    setNotice({ text: t("library.folders.suggest.running"), tone: "ok" });
    try {
      const r = await folderApi<{ suggested: number; byModel: number; modelSkipped: boolean; groups: SuggestionGroup[] }>(L, "/api/library/folders/suggestions", { action: "run" });
      setGroups(r.groups);
      const files = r.groups.reduce((n, g) => n + g.files.length, 0);
      const text = files ? t("library.folders.suggest.done", { count: files }) : t("library.folders.suggest.none");
      setNotice({ text: r.modelSkipped ? `${text} ${t("library.folders.suggest.muxDown")}` : text, tone: "ok" });
    } catch (e) {
      setNotice({ text: e instanceof Error ? e.message : t("library.folders.error.generic"), tone: "error" });
    } finally {
      setSuggesting(false);
    }
  }, [L, t]);

  const decide = useCallback(async (action: "accept" | "dismiss", ids: string[] | "all") => {
    setDeciding(true);
    try {
      const r = await folderApi<{ moved?: number; folders?: number; dismissed?: number; groups: SuggestionGroup[] }>(L, "/api/library/folders/suggestions", { action, sourceIds: ids });
      setGroups(r.groups);
      if (action === "accept") {
        setNotice({ text: t("library.folders.suggest.accepted", { count: r.moved ?? 0 }), tone: "ok" });
        void load(filters, true, Math.max(PAGE, shown));
        void loadFolders();
      }
    } catch (e) {
      setNotice({ text: e instanceof Error ? e.message : t("library.folders.error.generic"), tone: "error" });
    } finally {
      setDeciding(false);
    }
  }, [L, t, load, filters, shown, loadFolders]);

  const actions: FolderActions = useMemo(() => ({
    open: openFolder,
    moveFiles: (ids, folderId) => void moveFiles(ids, folderId),
    moveFolder: (f) => setDialog({ kind: "move", folder: f }),
    create: (parent) => setDialog({ kind: "name", state: { kind: "create", parent } }),
    rename: (f) => setDialog({ kind: "name", state: { kind: "rename", folder: f } }),
    sharing: (f) => setDialog({ kind: "sharing", folder: f }),
    remove: (f) => setDialog({ kind: "delete", folder: f }),
    templates: () => setDialog({ kind: "templates" }),
    saveTemplate: () => setDialog({ kind: "saveTemplate" }),
    suggest: () => void runSuggestions(),
  }), [openFolder, moveFiles, runSuggestions]);
  const closeDialog = useCallback(() => setDialog(null), []);
  const afterDialog = useCallback((message?: string) => {
    setDialog(null);
    if (message) setNotice({ text: message, tone: "ok" });
    refreshAll();
  }, [refreshAll]);

  // Selection: only files the viewer may move.
  const editable = items.filter((s) => s.canEdit);
  const selecting = selected.size > 0;
  const toggle = useCallback((id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) { n.delete(id); } else n.add(id); return n; }), []);
  const itemProps: ItemFolderProps = {
    folders: tree.folders, selected, selecting, toggle,
    dragIds: (id) => (selected.has(id) ? [...selected] : [id]),
    move: (ids, folderId) => void moveFiles(ids, folderId),
  };
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === "Escape" && selected.size && !dialog) setSelected(new Set()); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [selected.size, dialog]);

  const filtered = filters.type !== "" || filters.status !== "" || searching || ownerActive;
  const clear = () => { setFilters((f) => ({ type: "", status: "", q: "", folder: f.folder })); setOwner(""); };
  const emptyLibrary = !filtered && !filters.folder && data.total === 0 && !loading && tree.folders.length === 0;
  const failedCount = data.items.filter((s) => s.status === "failed").length;
  const here = folder ? trail(tree.folders, folder.id) : [];
  const heading = searching ? t("library.folders.searchingAll")
    : folder ? folder.name : filters.folder === "root" ? t("library.folders.unfiled") : filtered ? t("library.list.matching") : t("library.list.all");
  const parentOf = (f: FolderView) => (f.parentId ? findFolder(tree.folders, f.parentId)?.name ?? null : null);
  const uploadFolder = folder && !searching ? folder : null;

  return (
    <div className="lg:grid lg:grid-cols-[14rem_minmax(0,1fr)] lg:gap-8 xl:grid-cols-[16rem_minmax(0,1fr)] xl:gap-10">
      <aside className="hidden lg:block">
        <div className="sticky top-6 max-h-[calc(100vh-3rem)] overflow-y-auto pb-6 pr-1">
          <FolderSidebar L={L} tree={tree} current={filters.folder} actions={actions} suggesting={suggesting} />
        </div>
      </aside>

      <div className="min-w-0 space-y-10">
      <UploadZone family={family} onUploaded={onUploaded} statusOf={statusOf} onWatching={setWatchingUploads} prominent={emptyLibrary}
        folderId={uploadFolder?.id ?? null} folderName={uploadFolder?.name ?? null} />
      <ReadingQueue L={L} refreshKey={queueKey} onSettled={onQueueSettled} />
      {/* Suggestions belong to the overview and the unfiled files; inside a folder they would push its files down. */}
      {(filters.folder === "" || filters.folder === "root") && <FolderSuggestions L={L} groups={groups} busy={deciding} onAccept={(ids) => void decide("accept", ids)} onDismiss={(ids) => void decide("dismiss", ids)} />}

      {!emptyLibrary && (
        <section aria-labelledby="library-files-h">
          <FolderBar L={L} tree={tree} current={filters.folder} actions={actions} suggesting={suggesting} />
          {here.length > 1 && !searching && (
            <nav aria-label={t("library.folders.breadcrumb")} className="mb-1 hidden lg:block">
              <ol className="flex flex-wrap items-center gap-1 text-sm text-muted">
                {here.slice(0, -1).map((f) => (
                  <li key={f.id} className="flex items-center gap-1">
                    <button type="button" onClick={() => openFolder(f.id)} className="hover:text-fg hover:underline">{f.name}</button>
                    <span aria-hidden>›</span>
                  </li>
                ))}
              </ol>
            </nav>
          )}
          {/* Heading row: the count, then search, state and layout on the right. */}
          <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div className="flex min-w-0 items-baseline gap-3">
              <h2 id="library-files-h" className="truncate text-lg font-semibold tracking-[-0.01em]">{heading}</h2>
              <p className="shrink-0 text-sm tabular-nums text-muted" aria-live="polite">
                {loading ? t("library.list.looking") : t("library.count.files", { count: ownerActive ? items.length : data.total })}
                {!filtered && failedCount > 0 && (
                  <button type="button" className="ml-3 text-danger hover:underline" onClick={() => setFilters((f) => ({ ...f, status: "failed" }))}>
                    {t("library.list.failedCount", { count: failedCount })}
                  </button>
                )}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <div className="relative min-w-0 flex-1 md:w-64 md:flex-none">
                <label htmlFor={searchId} className="sr-only">{t("library.list.search")}</label>
                <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted" />
                <Input id={searchId} type="search" placeholder={t("library.list.searchPlaceholder")} value={filters.q}
                  onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))} className="h-8 pl-8 text-sm" />
              </div>
              <label className="sr-only" htmlFor={`${searchId}-status`}>{t("library.stateFilter.label")}</label>
              <Select id={`${searchId}-status`} value={filters.status} className="hidden h-8 w-44 text-sm sm:block"
                onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value as SourceStatus | "" }))}>
                {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{t(`library.stateFilter.${o.key}`)}</option>)}
              </Select>
              <Tabs value={view} onSelect={changeView} className="shrink-0" items={[
                { value: "grid", label: <><LayoutGrid aria-hidden className="size-4" /><span className="sr-only">{t("library.list.grid")}</span></> },
                { value: "table", label: <><Rows3 aria-hidden className="size-4" /><span className="sr-only">{t("library.list.table")}</span></> },
              ]} />
            </div>
          </div>
          {/* What kind of file, and (on phones) what state. Rebuilding the timeline from the library sits on the right. */}
          <div className="mb-5 flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
          <div className="-mx-4 min-w-0 max-w-full overflow-x-auto px-4 sm:mx-0 sm:px-0">
            <div className="flex w-max items-center gap-1">
              <div role="group" aria-label={t("library.filter.group")} className="flex gap-1">
                {KIND_FILTERS.map((k) => {
                  const on = filters.type === k.value;
                  return (
                    <button key={k.value || "all"} type="button" aria-pressed={on} onClick={() => setFilters((f) => ({ ...f, type: k.value }))}
                      className={clsx("h-8 whitespace-nowrap rounded-full px-3 text-sm transition-colors duration-150",
                        on ? "bg-fg font-medium text-bg" : "text-muted hover:bg-surface-2 hover:text-fg")}>
                      {t(`library.filter.${k.key}`)}
                    </button>
                  );
                })}
              </div>
              <Select aria-label={t("library.stateFilter.label")} value={filters.status} className="ml-2 h-8 w-auto text-sm sm:hidden"
                onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value as SourceStatus | "" }))}>
                {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{t(`library.stateFilter.${o.key}`)}</option>)}
              </Select>
            </div>
          </div>
          <RebuildButton onDone={onUploaded} className="ml-auto hidden min-w-0 justify-end lg:flex" />
          </div>

          {owners.length > 1 && (
            <div role="group" aria-label={t("library.list.addedBy")} className="-mt-1 mb-5 flex flex-wrap items-center gap-1.5">
              <span className="mr-1 text-sm text-muted">{t("library.list.addedBy")}</span>
              {owners.map((o) => {
                const on = owner === o.id;
                return (
                  <button key={o.id} type="button" aria-pressed={on} onClick={() => setOwner(on ? "" : o.id)}
                    className={clsx("inline-flex h-8 items-center gap-1.5 rounded-full py-0.5 pl-1 pr-3 text-sm transition-colors",
                      on ? "bg-fg text-bg" : "hover:bg-surface-2")}>
                    <Avatar id={o.id} name={o.name} size={24} />
                    <span className={on ? "font-medium" : ""}>{o.name}</span>
                    <span className={clsx("tabular-nums", on ? "text-bg/70" : "text-muted")}>{o.count}</span>
                  </button>
                );
              })}
            </div>
          )}

          {error && (
            <div role="alert" className="mb-5 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-danger-tint px-4 py-3 text-sm text-danger">
              <span>{error}</span>
              <Button type="button" variant="ghost" size="sm" className="text-danger" onClick={() => void load(filters)}>{t("library.list.tryAgain")}</Button>
            </div>
          )}

          <div className={clsx("transition-opacity duration-150", loading && "opacity-60")}>
            {items.length === 0 && !loading && !filtered && filters.folder ? (
              <EmptyPlace L={L} folder={folder} unfiled={filters.folder === "root"} tree={tree} actions={actions} />
            ) : items.length === 0 && !loading ? (
              <div className="rounded-lg bg-surface-2/60 px-6 py-10">
                <p className="font-medium">{filters.q.trim() ? t("library.list.nothingMatchesQ", { q: filters.q.trim() }) : t("library.list.nothingMatches")}</p>
                <p className="mt-1 text-sm text-muted">{t("library.list.nothingHint")}</p>
                <Button type="button" variant="secondary" size="sm" className="mt-4" onClick={clear}><X aria-hidden className="size-3.5" />{t("library.list.clear")}</Button>
              </div>
            ) : view === "grid" ? (
              <ul className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
                {items.map((s) => <li key={s.id}><Tile L={L} s={s} onRetry={retry} retrying={retrying.has(s.id)} f={itemProps} /></li>)}
              </ul>
            ) : (
              <FileTable L={L} items={items} onRetry={retry} retrying={retrying} f={itemProps}
                allSelected={editable.length > 0 && editable.every((s) => selected.has(s.id))}
                onSelectAll={(on) => setSelected(on ? new Set(editable.map((s) => s.id)) : new Set())} />
            )}
          </div>

          {!ownerActive && data.items.length < data.total && (
            <div className="mt-8 flex items-center gap-4">
              <Button type="button" variant="secondary" onClick={() => void loadMore()} disabled={loadingMore}>
                {loadingMore ? t("library.list.loadingMore") : t("library.list.showMore")}
              </Button>
              <span className="text-sm tabular-nums text-muted">{t("library.list.showing", { shown: data.items.length, total: data.total })}</span>
            </div>
          )}
        </section>
      )}
      </div>

      {/* Several files chosen: move them together. */}
      <AnimatePresence>
        {selecting && (
          <motion.div key="selection" role="region" aria-label={t("library.folders.selected", { count: selected.size })}
            initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 12 }} transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
            className="fixed inset-x-4 bottom-20 z-40 mx-auto flex max-w-md items-center gap-2 rounded-lg bg-fg py-2 pl-4 pr-2 text-bg shadow-float sm:bottom-6">
            <span className="min-w-0 flex-1 text-sm font-medium tabular-nums">{t("library.folders.selected", { count: selected.size })}</span>
            <MoveToMenu L={L} folders={tree.folders} current={filters.folder && filters.folder !== "root" ? filters.folder : filters.folder === "root" ? null : "__none__"}
              onMove={(id) => void moveFiles([...selected], id)} label={t("library.folders.moveSelected", { count: selected.size })}
              trigger={<><FolderInput aria-hidden className="size-4" />{t("library.folders.moveTo")}</>} align="right" side="top"
              triggerClassName="h-8 gap-2 rounded-md bg-bg/10 px-3 text-sm font-medium text-bg hover:bg-bg/20" />
            <button type="button" onClick={() => setSelected(new Set())} aria-label={t("library.folders.clearSelection")} title={t("library.folders.clearSelection")}
              className="inline-flex size-8 items-center justify-center rounded-md text-bg/80 hover:bg-bg/10 hover:text-bg">
              <X aria-hidden className="size-4" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {notice && (
          <motion.p key={notice.text} role="status" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }} transition={{ duration: 0.18 }}
            className={clsx("fixed left-1/2 z-40 w-max max-w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 rounded-lg px-4 py-2.5 text-sm shadow-float",
              selecting ? "bottom-36 sm:bottom-20" : "bottom-20 sm:bottom-6", notice.tone === "error" ? "bg-danger text-bg" : "bg-surface text-fg")}>
            {notice.text}
          </motion.p>
        )}
      </AnimatePresence>

      <NameDialog L={L} state={dialog?.kind === "name" ? dialog.state : null} onClose={closeDialog}
        onDone={(id) => { const creating = dialog?.kind === "name" && dialog.state.kind === "create"; afterDialog(); if (creating && id) openFolder(id); }} />
      <DeleteFolderDialog L={L} folder={dialog?.kind === "delete" ? dialog.folder : null} parentName={dialog?.kind === "delete" ? parentOf(dialog.folder) : null}
        onClose={closeDialog} onDone={(m) => afterDialog(m)} />
      <FolderSharingDialog L={L} folder={dialog?.kind === "sharing" ? dialog.folder : null} onClose={closeDialog} onDone={() => afterDialog()} />
      <MoveFolderDialog L={L} folder={dialog?.kind === "move" ? dialog.folder : null} folders={tree.folders} maxDepth={tree.maxDepth} onClose={closeDialog} onDone={() => afterDialog()} />
      <TemplatesDialog L={L} open={dialog?.kind === "templates"} defaultVisibility={graphKind === "personal" || graphKind === "practice" ? "private" : "household"} onClose={closeDialog} onDone={(m) => afterDialog(m)} />
      <SaveTemplateDialog L={L} open={dialog?.kind === "saveTemplate"} onClose={closeDialog} onDone={(m) => afterDialog(m)} />
    </div>
  );
}

/** An open folder (or "Not in a folder") with nothing in it: what will appear here, and how to fill it. */
function EmptyPlace({ L, folder, unfiled, tree, actions }: { L: Lx; folder: FolderView | null; unfiled: boolean; tree: FolderTree; actions: FolderActions }) {
  const { t } = L;
  if (unfiled) {
    return (
      <div className="rounded-lg bg-surface-2/60 px-6 py-10">
        <p className="font-medium">{t("library.folders.emptyUnfiled.title")}</p>
        <p className="mt-1 text-sm text-muted">{t("library.folders.emptyUnfiled.body")}</p>
      </div>
    );
  }
  if (!folder) return null;
  return (
    <div className="rounded-lg bg-surface-2/60 px-6 py-10">
      <p className="font-medium">{t("library.folders.emptyFolder.title", { name: folder.name })}</p>
      <p className="mt-1 max-w-[60ch] text-sm text-muted">{t("library.folders.emptyFolder.body")}</p>
      {folder.children.length > 0 && (
        <ul className="mt-4 flex flex-wrap gap-1.5">
          {folder.children.map((c) => (
            <li key={c.id}>
              <button type="button" onClick={() => actions.open(c.id)} className="inline-flex h-9 items-center gap-2 rounded-full bg-surface px-3.5 text-sm hover:bg-surface-2">
                <Folder aria-hidden className="size-4 text-muted" />{c.name}{c.count > 0 && <span className="tabular-nums text-xs text-muted">{c.count}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      {tree.canCreate && folder.depth < tree.maxDepth && (
        <Button type="button" variant="secondary" size="sm" className="mt-4" onClick={() => actions.create(folder)}>{t("library.folders.newInside", { name: folder.name })}</Button>
      )}
    </div>
  );
}

/** The opening lines of a short text file, so a letter looks like a letter. Small files only. */
function useExcerpt(s: SourceSummary, enabled: boolean): string | null {
  const [text, setText] = useState<string | null>(null);
  const ok = enabled && s.category === "text" && s.mime !== "text/csv" && (s.size ?? 0) > 0 && (s.size ?? 0) < 64 * 1024;
  useEffect(() => {
    if (!ok) return;
    const ctl = new AbortController();
    fetch(`/api/files/${s.id}`, { signal: ctl.signal })
      .then((r) => (r.ok ? r.text() : null))
      .then((t) => { if (t) setText(t.slice(0, 600)); })
      .catch(() => {});
    return () => ctl.abort();
  }, [ok, s.id]);
  return ok ? text : null;
}

function Thumb({ s, className, icon = "size-7", excerpt = false }: { s: SourceSummary; className?: string; icon?: string; excerpt?: boolean }) {
  const [broken, setBroken] = useState(false);
  const text = useExcerpt(s, excerpt);
  if (s.category === "image" && !broken && s.mime !== "image/heic") {
    // eslint-disable-next-line @next/next/no-img-element -- authenticated original, not optimisable by next/image
    return <img src={`/api/files/${s.id}`} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setBroken(true)} className={clsx("bg-surface-2 object-cover", className)} />;
  }
  if (text) {
    return (
      <div aria-hidden className={clsx("overflow-hidden bg-surface px-4 pt-4", className)}>
        <p className="line-clamp-[9] whitespace-pre-line break-words text-[10px]/[1.45] text-muted">{text}</p>
      </div>
    );
  }
  return (
    <div className={clsx("flex items-center justify-center bg-surface text-muted", className)}>
      <TypeIcon category={s.category} mime={s.mime} className={icon} />
    </div>
  );
}

/** Small marks after the date: whose it is (when not mine), who can see it, sensitive. */
function Marks({ L, s }: { L: Lx; s: SourceSummary }) {
  const { t } = L;
  return (
    <>
      {!s.isOwner && s.ownerName && (
        <span className="inline-flex min-w-0 items-center gap-1" title={t("library.list.addedByName", { name: s.ownerName })}>
          <Avatar id={s.ownerId} name={s.ownerName} size={16} />
          <span className="truncate">{s.ownerName}</span>
        </span>
      )}
      {s.visibility === "private" && <Lock aria-label={t("library.list.onlyYou")} className="size-3 shrink-0" />}
      {s.sensitive && <ShieldAlert aria-label={t("library.sensitive.label")} className="size-3 shrink-0 text-warn" />}
    </>
  );
}

/** The document's own date when it has one (letter written, email sent, photo taken), else when it was added. */
function ItemDate({ L, s }: { L: Lx; s: SourceSummary }) {
  const { t } = L;
  if (s.documentDate) {
    return (
      <time dateTime={s.documentDate} title={t("library.list.added", { day: formatDay(L, s.createdAt) })} className="shrink-0 text-fg/80">
        {formatDocDate(L, s.documentDate, s.documentDatePrecision)}
      </time>
    );
  }
  return <time dateTime={s.createdAt} title={t("library.list.addedNoDate")} className="shrink-0">{t("library.list.added", { day: formatDay(L, s.createdAt) })}</time>;
}

/** Mail: who wrote it and its conversation. Imports: how many messages. Anything: what reading it proposed. */
function MailLine({ L, s }: { L: Lx; s: SourceSummary }) {
  const { t } = L;
  const from = senderName(s.emailFrom);
  const parts: React.ReactNode[] = [];
  if (from) parts.push(<span key="from" className="truncate">{t("library.list.from", { name: from })}</span>);
  if (s.threadKey && s.threadCount > 1) {
    parts.push(
      <Link key="thread" href={`/library/thread?key=${encodeURIComponent(s.threadKey)}`} className="inline-flex shrink-0 items-center gap-1 text-accent hover:underline">
        <MessagesSquare aria-hidden className="size-3" />{t("library.list.inConversation", { count: s.threadCount })}
      </Link>,
    );
  }
  if (s.messages !== null) parts.push(<span key="msgs" className="shrink-0 tabular-nums">{t("library.list.imported", { imported: s.imported ?? 0, total: s.messages })}</span>);
  if (s.changeSetId && s.proposedTotal > 0) {
    parts.push(<Link key="prop" href={`/changes/${s.changeSetId}`} className="shrink-0 text-warn hover:underline">{t("library.list.proposed", { count: s.proposedTotal })}</Link>);
  }
  if (!parts.length) return null;
  return <p className="mt-0.5 flex min-w-0 items-center gap-2 text-xs text-muted">{parts}</p>;
}

function RetryLine({ L, s, onRetry, retrying }: { L: Lx; s: SourceSummary; onRetry: (id: string) => void; retrying: boolean }) {
  const { t } = L;
  const stuck = stuckOf(s);
  if (s.job?.status === "running") return <p className="mt-1.5 truncate text-xs text-accent">{stepText(L, s.job.progress)}</p>;
  if (s.job?.status === "queued") {
    return s.job.error ? <p className="mt-1.5 line-clamp-2 text-xs text-warn">{t("library.queue.retryingSoon", { reason: s.job.error })}</p> : null;
  }
  if (s.status !== "failed" && !stuck) return null;
  return (
    <div className="mt-1.5">
      <p className={clsx("line-clamp-2 text-xs", stuck ? "text-warn" : "text-danger")}>
        {stuck ? t("library.list.stoppedPartway") : s.error ?? t("library.list.readFailed")}
      </p>
      {s.isOwner && (
        <button type="button" onClick={() => onRetry(s.id)} disabled={retrying}
          className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-fg hover:underline disabled:opacity-50">
          <RefreshCw aria-hidden className={clsx("size-3", retrying && "motion-safe:animate-spin")} />{retrying ? t("library.list.starting") : t("library.list.readAgain")}
        </button>
      )}
    </div>
  );
}

/** Drag a file (or every chosen file, when it is one of them) onto a folder. */
function dragProps(s: SourceSummary, f: ItemFolderProps) {
  if (!s.canEdit) return {};
  return {
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(f.dragIds(s.id)));
      e.dataTransfer.effectAllowed = "move";
    },
  };
}

/** The tick box that chooses a file for moving together. */
function SelectBox({ L, s, f, className }: { L: Lx; s: SourceSummary; f: ItemFolderProps; className?: string }) {
  const on = f.selected.has(s.id);
  return (
    <button type="button" role="checkbox" aria-checked={on} aria-label={L.t("library.folders.select", { name: s.title })}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); f.toggle(s.id); }}
      className={clsx("inline-flex size-6 items-center justify-center rounded-md transition-[opacity,background-color] duration-150",
        on ? "bg-fg text-bg opacity-100" : "bg-surface/95 text-transparent ring-1 ring-line hover:text-muted",
        !on && !f.selecting && "opacity-0 focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100", className)}>
      <Check aria-hidden className="size-4" />
    </button>
  );
}

function ItemMove({ L, s, f, className }: { L: Lx; s: SourceSummary; f: ItemFolderProps; className?: string }) {
  if (!s.canEdit) return null;
  return (
    <MoveToMenu L={L} folders={f.folders} current={s.folderId} onMove={(id) => f.move(f.dragIds(s.id), id)}
      label={L.t("library.folders.moveToLabel", { name: s.title })} className={className}
      triggerClassName="size-7 text-muted hover:bg-surface-2 hover:text-fg" />
  );
}

function Tile({ L, s, onRetry, retrying, f }: { L: Lx; s: SourceSummary; onRetry: (id: string) => void; retrying: boolean; f: ItemFolderProps }) {
  const stuck = stuckOf(s);
  const ext = s.category !== "image" && s.category !== "text" ? extensionLabel(s.title) : null;
  const picked = f.selected.has(s.id);
  return (
    <article className="group relative min-w-0" {...dragProps(s, f)}>
      <Link href={`/library/${s.id}`} draggable={false} className={clsx("relative block overflow-hidden rounded-lg focus-visible:outline-offset-4", picked && "ring-2 ring-accent ring-offset-2 ring-offset-bg")} aria-label={s.title}>
        <Thumb s={s} excerpt className="aspect-[4/3] w-full transition-[filter] duration-150 group-hover:brightness-[0.97]" />
        {ext && <span className="absolute bottom-2.5 right-3 rounded bg-surface px-1 text-xs text-muted">{ext}</span>}
        <span className="absolute left-2 top-2"><StatusPill L={L} status={s.status} stuck={stuck} job={s.job} className="shadow-[0_1px_2px_rgb(0_0_0/0.08)]" /></span>
      </Link>
      {s.canEdit && <SelectBox L={L} s={s} f={f} className="absolute right-2 top-2" />}
      <div className="mt-2 flex min-w-0 items-center gap-1">
        <h3 className="min-w-0 flex-1 truncate text-sm font-medium" title={s.title}>
          <Link href={`/library/${s.id}`} draggable={false} className="hover:underline" tabIndex={-1}>{s.title}</Link>
        </h3>
        <ItemMove L={L} s={s} f={f} className="-my-1 -mr-1 shrink-0 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100" />
      </div>
      <p className="mt-0.5 flex min-w-0 items-center gap-2 text-xs text-muted">
        <ItemDate L={L} s={s} />
        <Marks L={L} s={s} />
      </p>
      <MailLine L={L} s={s} />
      <RetryLine L={L} s={s} onRetry={onRetry} retrying={retrying} />
    </article>
  );
}

function FileTable({ L, items, onRetry, retrying, f, allSelected, onSelectAll }: {
  L: Lx; items: SourceSummary[]; onRetry: (id: string) => void; retrying: Set<string>; f: ItemFolderProps;
  allSelected: boolean; onSelectAll: (on: boolean) => void;
}) {
  const { t } = L;
  const anyEditable = items.some((s) => s.canEdit);
  return (
    <>
      {/* Phones: two-line rows. */}
      <ul className="sm:hidden">
        {items.map((s) => (
          <li key={s.id} className={clsx("group flex gap-3 border-b border-line py-3 last:border-0", f.selected.has(s.id) && "bg-accent-tint/50")}>
            <Link href={`/library/${s.id}`} tabIndex={-1} aria-hidden draggable={false} className="shrink-0"><Thumb s={s} className="size-12 rounded-md" icon="size-5" /></Link>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <Link href={`/library/${s.id}`} className="min-w-0 flex-1 truncate text-sm font-medium hover:underline">{s.title}</Link>
                <StatusPill L={L} status={s.status} stuck={stuckOf(s)} job={s.job} />
                <ItemMove L={L} s={s} f={f} className="-my-1 shrink-0" />
              </div>
              <p className="mt-0.5 flex min-w-0 items-center gap-2 text-xs text-muted">
                <span className="shrink-0">{kindWord(L, s.docKind, s.category)}</span>
                <ItemDate L={L} s={s} />
                <Marks L={L} s={s} />
              </p>
              <MailLine L={L} s={s} />
              <RetryLine L={L} s={s} onRetry={onRetry} retrying={retrying.has(s.id)} />
            </div>
          </li>
        ))}
      </ul>

      {/* Wider screens: a real table. */}
      <table className="hidden w-full text-sm sm:table">
        <thead>
          <tr className="border-b border-line text-left text-xs text-muted">
            {anyEditable && (
              <th scope="col" className="w-8 py-2 pr-2 font-normal">
                <input type="checkbox" checked={allSelected} onChange={(e) => onSelectAll(e.target.checked)} aria-label={t("library.folders.selectAll")}
                  className="size-4 align-middle accent-[var(--fg)]" />
              </th>
            )}
            <th scope="col" className="py-2 pr-4 font-normal">{t("library.list.col.name")}</th>
            <th scope="col" className="hidden py-2 pr-4 font-normal md:table-cell">{t("library.list.col.kind")}</th>
            <th scope="col" className="py-2 pr-4 font-normal">{t("library.list.col.dated")}</th>
            <th scope="col" className="hidden py-2 pr-4 font-normal xl:table-cell">{t("library.list.col.added")}</th>
            <th scope="col" className="hidden py-2 pr-4 font-normal lg:table-cell">{t("library.list.col.by")}</th>
            <th scope="col" className="hidden py-2 pr-4 font-normal md:table-cell">{t("library.list.col.who")}</th>
            <th scope="col" className="hidden py-2 pr-4 text-right font-normal lg:table-cell">{t("library.list.col.size")}</th>
            <th scope="col" className="py-2 font-normal"><span className="sr-only">{t("library.list.col.state")}</span></th>
            {anyEditable && <th scope="col" className="w-9 py-2 font-normal"><span className="sr-only">{t("library.folders.moveTo")}</span></th>}
          </tr>
        </thead>
        <tbody>
          {items.map((s) => {
            const stuck = stuckOf(s);
            return (
              <tr key={s.id} {...dragProps(s, f)} className={clsx("group border-b border-line align-middle last:border-0", f.selected.has(s.id) ? "bg-accent-tint/50" : "hover:bg-surface/60")}>
                {anyEditable && (
                  <td className="py-2 pr-2">
                    {s.canEdit && <input type="checkbox" checked={f.selected.has(s.id)} onChange={() => f.toggle(s.id)} aria-label={t("library.folders.select", { name: s.title })}
                      className="size-4 align-middle accent-[var(--fg)]" />}
                  </td>
                )}
                <td className="max-w-0 py-2 pr-4 sm:w-[42%]">
                  <div className="flex items-center gap-3">
                    <Thumb s={s} className="size-9 shrink-0 rounded-md" icon="size-4" />
                    <div className="min-w-0">
                      <Link href={`/library/${s.id}`} draggable={false} className="block truncate font-medium hover:underline" title={s.title}>{s.title}</Link>
                      <MailLine L={L} s={s} />
                      {(s.status === "failed" || stuck || s.job) && <RetryLine L={L} s={s} onRetry={onRetry} retrying={retrying.has(s.id)} />}
                    </div>
                  </div>
                </td>
                <td className="hidden whitespace-nowrap py-2 pr-4 text-muted md:table-cell">{kindWord(L, s.docKind, s.category)}</td>
                <td className="whitespace-nowrap py-2 pr-4">
                  {s.documentDate ? <time dateTime={s.documentDate}>{formatDocDate(L, s.documentDate, s.documentDatePrecision)}</time> : <span className="text-muted">{t("library.list.noDate")}</span>}
                </td>
                <td className="hidden whitespace-nowrap py-2 pr-4 text-muted xl:table-cell"><time dateTime={s.createdAt}>{formatDay(L, s.createdAt)}</time></td>
                <td className="hidden py-2 pr-4 lg:table-cell">
                  <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-muted">
                    <Avatar id={s.ownerId} name={s.ownerName ?? "?"} size={20} />{s.isOwner ? t("library.list.you") : s.ownerName ?? t("library.list.someone")}
                  </span>
                </td>
                <td className="hidden whitespace-nowrap py-2 pr-4 text-muted md:table-cell">
                  <span className="inline-flex items-center gap-1.5">
                    {visibilityLabel(L, s.visibility)}
                    {s.sensitive && <span className="inline-flex items-center gap-0.5 text-warn"><ShieldAlert aria-hidden className="size-3.5" />{t("library.sensitive.label")}</span>}
                  </span>
                </td>
                <td className="hidden whitespace-nowrap py-2 pr-4 text-right tabular-nums text-muted lg:table-cell">{formatBytes(L, s.size) || "—"}</td>
                <td className="whitespace-nowrap py-2 text-right"><StatusPill L={L} status={s.status} stuck={stuck} job={s.job} /></td>
                {anyEditable && <td className="py-1 pl-1 text-right"><ItemMove L={L} s={s} f={f} /></td>}
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}
