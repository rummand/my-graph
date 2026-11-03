"use client";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { clsx } from "clsx";
import { LayoutGrid, Lock, RefreshCw, Rows3, Search, ShieldAlert, X } from "lucide-react";
import { Avatar, Button, Input, Select, Tabs } from "@/components/ui";
import type { SourceSummary } from "@/lib/ingest/library";
import type { FileCategory } from "@/lib/ingest/mime";
import { extensionLabel, formatBytes, formatDay, isStuck, KIND_WORD, StatusPill, TypeIcon, visibilityLabel, type SourceStatus } from "./source-meta";
import { UploadZone } from "./upload-zone";

export type LibraryFilters = { type: FileCategory | ""; status: SourceStatus | ""; q: string };
type List = { items: SourceSummary[]; total: number };

const KIND_FILTERS: { value: FileCategory | ""; label: string }[] = [
  { value: "", label: "Everything" },
  { value: "image", label: "Photos" },
  { value: "pdf", label: "PDFs" },
  { value: "document", label: "Documents" },
  { value: "email", label: "Emails" },
  { value: "audio", label: "Recordings" },
  { value: "text", label: "Notes" },
];
const STATUS_OPTIONS: { value: SourceStatus | ""; label: string }[] = [
  { value: "", label: "Any state" },
  { value: "processing", label: "Being read" },
  { value: "pending", label: "Waiting to be read" },
  { value: "failed", label: "Couldn't be read" },
  { value: "ready", label: "Read" },
];

const PAGE = 60;

function queryString(f: LibraryFilters, extra?: Record<string, string>) {
  const p = new URLSearchParams();
  if (f.type) p.set("type", f.type);
  if (f.status) p.set("status", f.status);
  if (f.q.trim()) p.set("q", f.q.trim());
  for (const [k, v] of Object.entries(extra ?? {})) p.set(k, v);
  return p.toString();
}

const busy = (s: SourceSummary) => (s.status === "pending" || s.status === "processing") && !isStuck(s.status, s.startedAt, s.createdAt);

export function LibraryView({ initial, initialFilters }: { initial: List; initialFilters: LibraryFilters }) {
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
  const reqId = useRef(0);
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

  const load = useCallback(async (f: LibraryFilters, quiet = false, limit = PAGE) => {
    const my = ++reqId.current;
    if (!quiet) setLoading(true);
    try {
      const qs = queryString(f, limit !== PAGE ? { limit: String(Math.min(limit, 200)) } : undefined);
      const res = await fetch(`/api/library${qs ? `?${qs}` : ""}`, { cache: "no-store" });
      const body = await res.json().catch(() => ({}));
      if (my !== reqId.current) return;
      if (!res.ok) throw new Error(body.error ?? "The library couldn't be loaded.");
      setData(body);
      setError(null);
    } catch (e) {
      if (my === reqId.current && !quiet) setError(e instanceof Error ? e.message : "The library couldn't be loaded.");
    } finally {
      if (my === reqId.current) setLoading(false);
    }
  }, []);

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

  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const qs = queryString(filters, { offset: String(data.items.length), limit: String(PAGE) });
      const res = await fetch(`/api/library?${qs}`, { cache: "no-store" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "More files couldn't be loaded.");
      setData((d) => {
        const seen = new Set(d.items.map((s) => s.id));
        return { items: [...d.items, ...(body.items as SourceSummary[]).filter((s) => !seen.has(s.id))], total: body.total };
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "More files couldn't be loaded.");
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
        setError(body.error ?? "Reading it again didn't start. Please try again.");
      }
      await load(filters, true, Math.max(PAGE, shown));
    } finally {
      setRetrying((s) => { const n = new Set(s); n.delete(id); return n; });
    }
  };

  // Who added what: the family members behind the files on screen.
  const owners = useMemo(() => {
    const m = new Map<string, { id: string; name: string; count: number }>();
    for (const s of data.items) {
      const cur = m.get(s.ownerId) ?? { id: s.ownerId, name: s.ownerName ?? "Someone", count: 0 };
      cur.count++;
      m.set(s.ownerId, cur);
    }
    return [...m.values()].sort((a, b) => b.count - a.count);
  }, [data.items]);
  const ownerActive = owner !== "" && owners.some((o) => o.id === owner);
  const items = ownerActive ? data.items.filter((s) => s.ownerId === owner) : data.items;

  const byId = useMemo(() => new Map(data.items.map((s) => [s.id, s])), [data.items]);
  const statusOf = useCallback((id: string) => byId.get(id), [byId]);
  const onUploaded = useCallback(() => void load(filters, true, Math.max(PAGE, shown)), [load, filters, shown]);

  const filtered = filters.type !== "" || filters.status !== "" || filters.q.trim() !== "" || ownerActive;
  const clear = () => { setFilters({ type: "", status: "", q: "" }); setOwner(""); };
  const emptyLibrary = !filtered && data.total === 0 && !loading;
  const failedCount = data.items.filter((s) => s.status === "failed").length;

  return (
    <div className="space-y-10">
      <UploadZone onUploaded={onUploaded} statusOf={statusOf} onWatching={setWatchingUploads} prominent={emptyLibrary} />

      {!emptyLibrary && (
        <section aria-labelledby="library-files-h">
          {/* Heading row: the count, then search, state and layout on the right. */}
          <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div className="flex items-baseline gap-3">
              <h2 id="library-files-h" className="text-lg font-semibold tracking-[-0.01em]">{filtered ? "Matching files" : "All files"}</h2>
              <p className="text-sm tabular-nums text-muted" aria-live="polite">
                {loading ? "Looking…" : countLine(ownerActive ? items.length : data.total)}
                {!filtered && failedCount > 0 && (
                  <button type="button" className="ml-3 text-danger hover:underline" onClick={() => setFilters((f) => ({ ...f, status: "failed" }))}>
                    {failedCount} couldn&apos;t be read
                  </button>
                )}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <div className="relative min-w-0 flex-1 md:w-64 md:flex-none">
                <label htmlFor={searchId} className="sr-only">Search the library</label>
                <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted" />
                <Input id={searchId} type="search" placeholder="Search names and text" value={filters.q}
                  onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))} className="h-8 pl-8 text-sm" />
              </div>
              <label className="sr-only" htmlFor={`${searchId}-status`}>State</label>
              <Select id={`${searchId}-status`} value={filters.status} className="hidden h-8 w-44 text-sm sm:block"
                onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value as SourceStatus | "" }))}>
                {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </Select>
              <Tabs value={view} onSelect={changeView} className="shrink-0" items={[
                { value: "grid", label: <><LayoutGrid aria-hidden className="size-4" /><span className="sr-only">Grid</span></> },
                { value: "table", label: <><Rows3 aria-hidden className="size-4" /><span className="sr-only">Table</span></> },
              ]} />
            </div>
          </div>

          {/* What kind of file, and (on phones) what state. */}
          <div className="-mx-4 mb-5 overflow-x-auto px-4 sm:mx-0 sm:px-0">
            <div className="flex w-max items-center gap-1">
              <div role="group" aria-label="Kind of file" className="flex gap-1">
                {KIND_FILTERS.map((k) => {
                  const on = filters.type === k.value;
                  return (
                    <button key={k.value || "all"} type="button" aria-pressed={on} onClick={() => setFilters((f) => ({ ...f, type: k.value }))}
                      className={clsx("h-8 whitespace-nowrap rounded-full px-3 text-sm transition-colors duration-150",
                        on ? "bg-fg font-medium text-bg" : "text-muted hover:bg-surface-2 hover:text-fg")}>
                      {k.label}
                    </button>
                  );
                })}
              </div>
              <Select aria-label="State" value={filters.status} className="ml-2 h-8 w-auto text-sm sm:hidden"
                onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value as SourceStatus | "" }))}>
                {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </Select>
            </div>
          </div>

          {owners.length > 1 && (
            <div role="group" aria-label="Added by" className="-mt-1 mb-5 flex flex-wrap items-center gap-1.5">
              <span className="mr-1 text-sm text-muted">Added by</span>
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
              <Button type="button" variant="ghost" size="sm" className="text-danger" onClick={() => void load(filters)}>Try again</Button>
            </div>
          )}

          <div className={clsx("transition-opacity duration-150", loading && "opacity-60")}>
            {items.length === 0 && !loading ? (
              <div className="rounded-lg bg-surface-2/60 px-6 py-10">
                <p className="font-medium">Nothing matches{filters.q.trim() ? ` “${filters.q.trim()}”` : ""}</p>
                <p className="mt-1 text-sm text-muted">Search looks in file names and in the text read from each file. Try another word, or clear the filters.</p>
                <Button type="button" variant="secondary" size="sm" className="mt-4" onClick={clear}><X aria-hidden className="size-3.5" />Clear filters</Button>
              </div>
            ) : view === "grid" ? (
              <ul className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                {items.map((s) => <li key={s.id}><Tile s={s} onRetry={retry} retrying={retrying.has(s.id)} /></li>)}
              </ul>
            ) : (
              <FileTable items={items} onRetry={retry} retrying={retrying} />
            )}
          </div>

          {!ownerActive && data.items.length < data.total && (
            <div className="mt-8 flex items-center gap-4">
              <Button type="button" variant="secondary" onClick={() => void loadMore()} disabled={loadingMore}>
                {loadingMore ? "Loading…" : "Show more"}
              </Button>
              <span className="text-sm tabular-nums text-muted">Showing {data.items.length} of {data.total}</span>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function countLine(total: number) {
  return `${total} ${total === 1 ? "file" : "files"}`;
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
    return <img src={`/api/files/${s.id}`} alt="" loading="lazy" decoding="async" onError={() => setBroken(true)} className={clsx("bg-surface-2 object-cover", className)} />;
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
function Marks({ s }: { s: SourceSummary }) {
  return (
    <>
      {!s.isOwner && s.ownerName && (
        <span className="inline-flex min-w-0 items-center gap-1" title={`Added by ${s.ownerName}`}>
          <Avatar id={s.ownerId} name={s.ownerName} size={16} />
          <span className="truncate">{s.ownerName}</span>
        </span>
      )}
      {s.visibility === "private" && <Lock aria-label="Only you can see this" className="size-3 shrink-0" />}
      {s.sensitive && <ShieldAlert aria-label="Sensitive" className="size-3 shrink-0 text-warn" />}
    </>
  );
}

function RetryLine({ s, onRetry, retrying }: { s: SourceSummary; onRetry: (id: string) => void; retrying: boolean }) {
  const stuck = isStuck(s.status, s.startedAt, s.createdAt);
  if (s.status !== "failed" && !stuck) return null;
  return (
    <div className="mt-1.5">
      <p className={clsx("line-clamp-2 text-xs", stuck ? "text-warn" : "text-danger")}>
        {stuck ? "Reading stopped partway, probably at a restart." : s.error ?? "Reading this file failed."}
      </p>
      {s.isOwner && (
        <button type="button" onClick={() => onRetry(s.id)} disabled={retrying}
          className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-fg hover:underline disabled:opacity-50">
          <RefreshCw aria-hidden className={clsx("size-3", retrying && "motion-safe:animate-spin")} />{retrying ? "Starting…" : "Read it again"}
        </button>
      )}
    </div>
  );
}

function Tile({ s, onRetry, retrying }: { s: SourceSummary; onRetry: (id: string) => void; retrying: boolean }) {
  const stuck = isStuck(s.status, s.startedAt, s.createdAt);
  const ext = s.category !== "image" && s.category !== "text" ? extensionLabel(s.title) : null;
  return (
    <article className="group min-w-0">
      <Link href={`/library/${s.id}`} className="relative block overflow-hidden rounded-lg focus-visible:outline-offset-4" aria-label={s.title}>
        <Thumb s={s} excerpt className="aspect-[4/3] w-full transition-[filter] duration-150 group-hover:brightness-[0.97]" />
        {ext && <span className="absolute bottom-2.5 right-3 rounded bg-surface px-1 text-xs text-muted">{ext}</span>}
        <span className="absolute left-2 top-2"><StatusPill status={s.status} stuck={stuck} className="shadow-[0_1px_2px_rgb(0_0_0/0.08)]" /></span>
      </Link>
      <h3 className="mt-2 truncate text-sm font-medium" title={s.title}>
        <Link href={`/library/${s.id}`} className="hover:underline" tabIndex={-1}>{s.title}</Link>
      </h3>
      <p className="mt-0.5 flex min-w-0 items-center gap-2 text-xs text-muted">
        <time dateTime={s.takenAt ?? s.createdAt} className="shrink-0 tabular-nums">{formatDay(s.takenAt ?? s.createdAt)}</time>
        <Marks s={s} />
      </p>
      <RetryLine s={s} onRetry={onRetry} retrying={retrying} />
    </article>
  );
}

function FileTable({ items, onRetry, retrying }: { items: SourceSummary[]; onRetry: (id: string) => void; retrying: Set<string> }) {
  return (
    <>
      {/* Phones: two-line rows. */}
      <ul className="sm:hidden">
        {items.map((s) => (
          <li key={s.id} className="flex gap-3 border-b border-line py-3 last:border-0">
            <Link href={`/library/${s.id}`} tabIndex={-1} aria-hidden className="shrink-0"><Thumb s={s} className="size-12 rounded-md" icon="size-5" /></Link>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <Link href={`/library/${s.id}`} className="min-w-0 flex-1 truncate text-sm font-medium hover:underline">{s.title}</Link>
                <StatusPill status={s.status} stuck={isStuck(s.status, s.startedAt, s.createdAt)} />
              </div>
              <p className="mt-0.5 flex min-w-0 items-center gap-2 text-xs text-muted">
                <span className="shrink-0">{KIND_WORD[s.category]}</span>
                <time dateTime={s.createdAt} className="shrink-0 tabular-nums">{formatDay(s.takenAt ?? s.createdAt)}</time>
                <Marks s={s} />
              </p>
              <RetryLine s={s} onRetry={onRetry} retrying={retrying.has(s.id)} />
            </div>
          </li>
        ))}
      </ul>

      {/* Wider screens: a real table. */}
      <table className="hidden w-full text-sm sm:table">
        <thead>
          <tr className="border-b border-line text-left text-xs text-muted">
            <th scope="col" className="py-2 pr-4 font-normal">Name</th>
            <th scope="col" className="hidden py-2 pr-4 font-normal md:table-cell">Kind</th>
            <th scope="col" className="py-2 pr-4 font-normal">Added</th>
            <th scope="col" className="hidden py-2 pr-4 font-normal lg:table-cell">By</th>
            <th scope="col" className="hidden py-2 pr-4 font-normal md:table-cell">Who can see it</th>
            <th scope="col" className="hidden py-2 pr-4 text-right font-normal lg:table-cell">Size</th>
            <th scope="col" className="py-2 font-normal"><span className="sr-only">State</span></th>
          </tr>
        </thead>
        <tbody>
          {items.map((s) => {
            const stuck = isStuck(s.status, s.startedAt, s.createdAt);
            return (
              <tr key={s.id} className="group border-b border-line align-middle last:border-0 hover:bg-surface/60">
                <td className="max-w-0 py-2 pr-4 sm:w-[42%]">
                  <div className="flex items-center gap-3">
                    <Thumb s={s} className="size-9 shrink-0 rounded-md" icon="size-4" />
                    <div className="min-w-0">
                      <Link href={`/library/${s.id}`} className="block truncate font-medium hover:underline" title={s.title}>{s.title}</Link>
                      {(s.status === "failed" || stuck) && <RetryLine s={s} onRetry={onRetry} retrying={retrying.has(s.id)} />}
                    </div>
                  </div>
                </td>
                <td className="hidden whitespace-nowrap py-2 pr-4 text-muted md:table-cell">{KIND_WORD[s.category]}</td>
                <td className="whitespace-nowrap py-2 pr-4 tabular-nums text-muted"><time dateTime={s.createdAt}>{formatDay(s.createdAt)}</time></td>
                <td className="hidden py-2 pr-4 lg:table-cell">
                  <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-muted">
                    <Avatar id={s.ownerId} name={s.ownerName ?? "?"} size={20} />{s.isOwner ? "You" : s.ownerName ?? "Someone"}
                  </span>
                </td>
                <td className="hidden whitespace-nowrap py-2 pr-4 text-muted md:table-cell">
                  <span className="inline-flex items-center gap-1.5">
                    {visibilityLabel(s.visibility)}
                    {s.sensitive && <span className="inline-flex items-center gap-0.5 text-warn"><ShieldAlert aria-hidden className="size-3.5" />Sensitive</span>}
                  </span>
                </td>
                <td className="hidden whitespace-nowrap py-2 pr-4 text-right tabular-nums text-muted lg:table-cell">{formatBytes(s.size) || "—"}</td>
                <td className="whitespace-nowrap py-2 text-right"><StatusPill status={s.status} stuck={stuck} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}
