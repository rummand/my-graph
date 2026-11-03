"use client";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { clsx } from "clsx";
import { format } from "date-fns";
import { LayoutGrid, List, Lock, RefreshCw, Search, ShieldAlert } from "lucide-react";
import { Button, EmptyState, Input } from "@/components/ui";
import type { SourceSummary } from "@/lib/ingest/library";
import { CATEGORY_LABEL, type FileCategory } from "@/lib/ingest/mime";
import { formatBytes, isStuck, StatusPill, TypeIcon, visibilityLabel, type SourceStatus } from "./source-meta";
import { UploadZone } from "./upload-zone";

export type LibraryFilters = { type: FileCategory | ""; status: SourceStatus | ""; q: string };

const TYPE_OPTIONS: { value: FileCategory | ""; label: string }[] = [
  { value: "", label: "All types" },
  { value: "pdf", label: "PDFs" },
  { value: "document", label: "Word documents" },
  { value: "image", label: "Photos" },
  { value: "audio", label: "Audio" },
  { value: "email", label: "Emails" },
  { value: "text", label: "Text files" },
];
const STATUS_OPTIONS: { value: SourceStatus | ""; label: string }[] = [
  { value: "", label: "Any status" },
  { value: "processing", label: "Being read" },
  { value: "pending", label: "Queued" },
  { value: "ready", label: "Ready" },
  { value: "failed", label: "Failed" },
];

function queryString(f: LibraryFilters) {
  const p = new URLSearchParams();
  if (f.type) p.set("type", f.type);
  if (f.status) p.set("status", f.status);
  if (f.q.trim()) p.set("q", f.q.trim());
  return p.toString();
}

export function LibraryView({ initial, initialFilters }: { initial: { items: SourceSummary[]; total: number }; initialFilters: LibraryFilters }) {
  const ids = { type: useId(), status: useId(), q: useId() };
  const [filters, setFilters] = useState<LibraryFilters>(initialFilters);
  const [data, setData] = useState(initial);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"grid" | "list">("grid");
  const [retrying, setRetrying] = useState<Set<string>>(new Set());
  const reqId = useRef(0);
  const first = useRef(true);

  useEffect(() => {
    try {
      const saved = localStorage.getItem("library:view");
      if (saved === "grid" || saved === "list") setView(saved);
    } catch { /* storage unavailable */ }
  }, []);
  const changeView = (v: "grid" | "list") => {
    setView(v);
    try { localStorage.setItem("library:view", v); } catch { /* ignore */ }
  };

  const load = useCallback(async (f: LibraryFilters, quiet = false) => {
    const my = ++reqId.current;
    if (!quiet) setLoading(true);
    try {
      const qs = queryString(f);
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

  // Poll while anything is being read.
  const active = data.items.some((s) => (s.status === "pending" || s.status === "processing") && !isStuck(s.status, s.startedAt, s.createdAt));
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => void load(filters, true), 3000);
    return () => clearInterval(t);
  }, [active, filters, load]);

  const retry = async (id: string) => {
    setRetrying((s) => new Set(s).add(id));
    try {
      const res = await fetch(`/api/library/${id}/reprocess`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? "Retry failed. Please try again.");
      }
      await load(filters, true);
    } finally {
      setRetrying((s) => { const n = new Set(s); n.delete(id); return n; });
    }
  };

  const filtered = filters.type !== "" || filters.status !== "" || filters.q.trim() !== "";

  return (
    <div className="space-y-6">
      <UploadZone onUploaded={() => void load(filters, true)} />

      <section aria-labelledby="library-files-h" className="space-y-4">
        <h2 id="library-files-h" className="sr-only">Your files</h2>
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-0 flex-1 basis-56">
            <label htmlFor={ids.q} className="mb-1 block text-sm font-medium">Search</label>
            <div className="relative">
              <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted" />
              <Input id={ids.q} type="search" placeholder="Name or words inside the file" value={filters.q}
                onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))} className="pl-8" />
            </div>
          </div>
          <div className="basis-36">
            <label htmlFor={ids.type} className="mb-1 block text-sm font-medium">Type</label>
            <select id={ids.type} value={filters.type} onChange={(e) => setFilters((f) => ({ ...f, type: e.target.value as FileCategory | "" }))}
              className="w-full rounded-md border border-line bg-surface px-3 py-2 text-sm">
              {TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div className="basis-36">
            <label htmlFor={ids.status} className="mb-1 block text-sm font-medium">Status</label>
            <select id={ids.status} value={filters.status} onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value as SourceStatus | "" }))}
              className="w-full rounded-md border border-line bg-surface px-3 py-2 text-sm">
              {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div role="group" aria-label="Layout" className="flex rounded-md border border-line bg-surface p-0.5">
            <button type="button" aria-pressed={view === "grid"} onClick={() => changeView("grid")} title="Grid"
              className={clsx("rounded p-1.5", view === "grid" ? "bg-accent-tint text-accent" : "text-muted hover:text-fg")}>
              <LayoutGrid aria-hidden className="size-4" /><span className="sr-only">Grid</span>
            </button>
            <button type="button" aria-pressed={view === "list"} onClick={() => changeView("list")} title="List"
              className={clsx("rounded p-1.5", view === "list" ? "bg-accent-tint text-accent" : "text-muted hover:text-fg")}>
              <List aria-hidden className="size-4" /><span className="sr-only">List</span>
            </button>
          </div>
        </div>

        <p className="text-sm text-muted" aria-live="polite">
          {loading ? "Loading…" : `${data.total} ${data.total === 1 ? "file" : "files"}${filtered ? " match" : ""}`}
        </p>

        {error && (
          <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line bg-surface px-3 py-2 text-sm text-danger">
            <span>{error}</span>
            <Button type="button" variant="secondary" onClick={() => void load(filters)}>Try again</Button>
          </div>
        )}

        {data.items.length === 0 && !loading ? (
          filtered ? (
            <EmptyState title="Nothing matches">
              <p>Try a different word or clear the filters.</p>
              <Button type="button" variant="secondary" className="mt-3" onClick={() => setFilters({ type: "", status: "", q: "" })}>Clear filters</Button>
            </EmptyState>
          ) : (
            <EmptyState title="Your library is empty">
              <p>Add school letters, appointment cards, photos, voice memos or exported emails. My Graph reads them and links the people, places and dates it finds.</p>
            </EmptyState>
          )
        ) : view === "grid" ? (
          <ul className="grid grid-cols-1 gap-3 min-[400px]:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {data.items.map((s) => <li key={s.id}><SourceCard s={s} onRetry={retry} retrying={retrying.has(s.id)} /></li>)}
          </ul>
        ) : (
          <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
            {data.items.map((s) => <li key={s.id}><SourceRow s={s} onRetry={retry} retrying={retrying.has(s.id)} /></li>)}
          </ul>
        )}
      </section>
    </div>
  );
}

function Thumb({ s, className }: { s: SourceSummary; className?: string }) {
  const [broken, setBroken] = useState(false);
  if (s.category === "image" && !broken && s.mime !== "image/heic") {
    // eslint-disable-next-line @next/next/no-img-element -- authenticated original, not optimisable by next/image
    return <img src={`/api/files/${s.id}`} alt="" loading="lazy" decoding="async" onError={() => setBroken(true)} className={clsx("object-cover", className)} />;
  }
  return (
    <div className={clsx("flex items-center justify-center bg-surface-2 text-muted", className)}>
      <TypeIcon category={s.category} mime={s.mime} className="size-8" />
    </div>
  );
}

function MetaLine({ s }: { s: SourceSummary }) {
  const when = s.takenAt ?? s.createdAt;
  return (
    <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted">
      <span>{CATEGORY_LABEL[s.category]}</span>
      {s.size ? <><span aria-hidden>·</span><span>{formatBytes(s.size)}</span></> : null}
      <span aria-hidden>·</span>
      <time dateTime={when}>{format(new Date(when), "d MMM yyyy")}</time>
      {!s.isOwner && s.ownerName && <><span aria-hidden>·</span><span>from {s.ownerName}</span></>}
      <span aria-hidden>·</span>
      <span className="inline-flex items-center gap-0.5">{s.visibility === "private" && <Lock aria-hidden className="size-3" />}{visibilityLabel(s.visibility)}</span>
      {s.sensitive && <span className="inline-flex items-center gap-0.5 text-warn"><ShieldAlert aria-hidden className="size-3" />Sensitive</span>}
    </p>
  );
}

function Failure({ s, onRetry, retrying }: { s: SourceSummary; onRetry: (id: string) => void; retrying: boolean }) {
  const stuck = isStuck(s.status, s.startedAt, s.createdAt);
  if (s.status !== "failed" && !stuck) return null;
  return (
    <div className="mt-2 space-y-2">
      <p className="line-clamp-3 text-xs text-danger">{stuck ? "This has been reading for a long time and may have stopped." : s.error ?? "Reading this file failed."}</p>
      {s.isOwner && (
        <Button type="button" variant="secondary" className="px-2 py-1 text-xs" onClick={() => onRetry(s.id)} disabled={retrying}>
          <RefreshCw aria-hidden className={clsx("size-3.5", retrying && "motion-safe:animate-spin")} />{retrying ? "Retrying…" : "Retry"}
        </Button>
      )}
    </div>
  );
}

function SourceCard({ s, onRetry, retrying }: { s: SourceSummary; onRetry: (id: string) => void; retrying: boolean }) {
  return (
    <article className="flex h-full flex-col overflow-hidden rounded-lg border border-line bg-surface">
      <Link href={`/library/${s.id}`} className="block" tabIndex={-1} aria-hidden>
        <Thumb s={s} className="aspect-[4/3] w-full" />
      </Link>
      <div className="flex flex-1 flex-col gap-1.5 p-3">
        <div className="flex items-start gap-2">
          <TypeIcon category={s.category} mime={s.mime} className="mt-0.5 size-4 text-muted" />
          <h3 className="min-w-0 flex-1 text-sm font-medium">
            <Link href={`/library/${s.id}`} className="line-clamp-2 break-words hover:underline">{s.title}</Link>
          </h3>
        </div>
        <MetaLine s={s} />
        <div><StatusPill status={s.status} stuck={isStuck(s.status, s.startedAt, s.createdAt)} /></div>
        <Failure s={s} onRetry={onRetry} retrying={retrying} />
      </div>
    </article>
  );
}

function SourceRow({ s, onRetry, retrying }: { s: SourceSummary; onRetry: (id: string) => void; retrying: boolean }) {
  return (
    <article className="flex gap-3 p-3">
      <Thumb s={s} className="size-12 shrink-0 rounded-md" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="min-w-0 text-sm font-medium"><Link href={`/library/${s.id}`} className="break-words hover:underline">{s.title}</Link></h3>
          <StatusPill status={s.status} stuck={isStuck(s.status, s.startedAt, s.createdAt)} />
        </div>
        <MetaLine s={s} />
        <Failure s={s} onRetry={onRetry} retrying={retrying} />
      </div>
    </article>
  );
}
