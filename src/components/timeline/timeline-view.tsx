"use client";
/** The timeline page body: filters, search, presets, then swimlanes (desktop) or a month list (phones), plus the drawer. */
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { clsx } from "clsx";
import { Search } from "lucide-react";
import { Button, EmptyState } from "@/components/ui";
import { formatWhen, presetDomain, searchItems, type Preset } from "@/lib/timeline/pure";
import type { TimelineData, TimelineItem } from "@/lib/timeline/types";
import { EventDrawer } from "./event-drawer";
import { useMediaQuery } from "./hooks";
import { ItemGlyph, Legend } from "./marks";
import { MobileList } from "./mobile-list";
import { Swimlanes, type SwimlaneHandle } from "./swimlanes";

const PRESETS: { key: Preset; label: string }[] = [
  { key: "week", label: "Week" }, { key: "month", label: "Month" }, { key: "year", label: "Year" }, { key: "all", label: "All" },
];

type Filters = { people: string[]; topics: string[]; uploads: boolean };
const NO_FILTERS: Filters = { people: [], topics: [], uploads: false };

function queryString(f: Filters): string {
  const p = new URLSearchParams();
  if (f.people.length) p.set("people", f.people.join(","));
  if (f.topics.length) p.set("topics", f.topics.join(","));
  p.set("types", f.uploads ? "event,reminder,source" : "event,reminder");
  return p.toString();
}

export function TimelineView({ initial, initialError }: { initial: TimelineData | null; initialError?: string | null }) {
  const isPhone = useMediaQuery("(max-width: 639px)");
  const [data, setData] = useState<TimelineData | null>(initial);
  const [error, setError] = useState<string | null>(initialError ?? null);
  const [loading, setLoading] = useState(!initial && !initialError);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [reload, setReload] = useState(0);
  const [selected, setSelected] = useState<TimelineItem | null>(null);
  const [jumpId, setJumpId] = useState<string | null>(null);
  const lanesRef = useRef<SwimlaneHandle>(null);
  const firstFetch = useRef(!!initial);

  useEffect(() => {
    if (firstFetch.current) { firstFetch.current = false; return; }
    const ac = new AbortController();
    setLoading(true);
    fetch(`/api/timeline?${queryString(filters)}`, { signal: ac.signal, headers: { accept: "application/json" } })
      .then(async (r) => {
        const body = await r.json().catch(() => null);
        if (!r.ok) throw new Error(body && typeof body.error === "string" ? body.error : "We couldn't load the timeline.");
        setData(body as TimelineData);
        setError(null);
      })
      .catch((err: unknown) => {
        if (ac.signal.aborted) return;
        setError(err instanceof Error && !/fetch/i.test(err.message) ? err.message : "We couldn't reach the server. Check your connection and try again.");
      })
      .finally(() => { if (!ac.signal.aborted) setLoading(false); });
    return () => ac.abort();
  }, [filters, reload]);

  const peopleById = useMemo(() => new Map((data?.people ?? []).map((p) => [p.id, p.label])), [data]);
  const items = useMemo(() => data?.items ?? [], [data]);

  // Keep the open drawer pointing at fresh data after a refetch (or close it if the item is gone).
  useEffect(() => {
    setSelected((s) => (s ? items.find((i) => i.id === s.id) ?? null : s));
  }, [items]);

  const initialPreset = useMemo<Preset>(() => {
    const [a, b] = presetDomain("year", new Date(), null);
    return items.some((i) => { const t = new Date(i.start).getTime(); return t >= a.getTime() && t <= b.getTime(); }) ? "year" : "all";
    // Only decided once, from the first data we have.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data === null]);

  const onSelect = useCallback((it: TimelineItem) => setSelected(it), []);
  const onClose = useCallback(() => setSelected(null), []);

  const jumpTo = (it: TimelineItem) => {
    setSelected(it);
    setJumpId(it.id);
    lanesRef.current?.focusItem(it);
  };

  const filtered = filters.people.length > 0 || filters.topics.length > 0;
  const toggle = (key: "people" | "topics", id: string) =>
    setFilters((f) => ({ ...f, [key]: f[key].includes(id) ? f[key].filter((x) => x !== id) : [...f[key], id] }));

  if (!data && loading) return <TimelineSkeleton />;
  if (!data) {
    return (
      <div role="alert" className="rounded-lg border border-line bg-surface p-6">
        <p className="font-medium">The timeline didn&apos;t load.</p>
        <p className="mt-1 text-sm text-muted">{error ?? "Something went wrong."}</p>
        <Button className="mt-4" variant="secondary" onClick={() => setReload((n) => n + 1)}>Try again</Button>
      </div>
    );
  }

  const nothingAtAll = items.length === 0 && !filtered;

  return (
    <div className="space-y-4">
      {nothingAtAll && !filters.uploads ? (
        <EmptyState title="Nothing on the timeline yet">
          <p className="mx-auto max-w-md">
            Events appear here when you upload documents — school letters, appointment cards, invitations — or write wiki
            pages that mention dates. Each event gets a lane for the people it involves.
          </p>
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            <Link href="/library" className="inline-flex items-center rounded-md bg-accent px-3 py-2 text-sm font-medium text-accent-fg hover:opacity-90">Upload a document</Link>
            <Link href="/wiki" className="inline-flex items-center rounded-md border border-line bg-surface px-3 py-2 text-sm font-medium text-fg hover:bg-surface-2">Write a wiki page</Link>
          </div>
          <button type="button" className="mt-3 text-xs font-medium text-accent hover:underline" onClick={() => setFilters((f) => ({ ...f, uploads: true }))}>
            Already uploaded something? Show uploads on the timeline
          </button>
        </EmptyState>
      ) : (
        <>
          <Toolbar
            data={data} filters={filters} isPhone={isPhone} loading={loading}
            onPreset={(p) => lanesRef.current?.zoomToPreset(p)}
            onToggle={toggle}
            onUploads={(uploads) => setFilters((f) => ({ ...f, uploads }))}
            onClear={() => setFilters((f) => ({ ...NO_FILTERS, uploads: f.uploads }))}
            onJump={jumpTo}
          />

          {error && (
            <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line bg-surface px-3 py-2 text-sm">
              <span className="text-danger">{error}</span>
              <button type="button" className="font-medium text-accent hover:underline" onClick={() => setReload((n) => n + 1)}>Try again</button>
            </div>
          )}
          {data.truncated && (
            <p className="rounded-md bg-surface-2 px-3 py-2 text-sm text-muted">
              There are more events than we can draw at once, so only the first {items.filter((i) => i.kind === "event").length.toLocaleString()} are shown. Filter by a person or topic to see the rest.
            </p>
          )}

          {items.length === 0 ? (
            <EmptyState title="Nothing matches these filters">
              <p>Try fewer people or topics.</p>
              <Button variant="secondary" className="mt-3" onClick={() => setFilters((f) => ({ ...NO_FILTERS, uploads: f.uploads }))}>Clear filters</Button>
            </EmptyState>
          ) : (
            <div className={clsx("transition-opacity", loading && "opacity-60")} aria-busy={loading}>
              {isPhone ? (
                <MobileList items={items} peopleById={peopleById} selectedId={selected?.id ?? null} onSelect={onSelect} scrollToId={jumpId} />
              ) : (
                <Swimlanes ref={lanesRef} lanes={data.lanes} items={items} peopleById={peopleById}
                  selectedId={selected?.id ?? null} onSelect={onSelect} initialPreset={initialPreset} />
              )}
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3">
            <Legend />
            {!isPhone && <p className="text-xs text-muted">Scroll or pinch to zoom · drag to move · ← → + − and T on the keyboard</p>}
          </div>
        </>
      )}

      <EventDrawer item={selected} peopleById={peopleById} onClose={onClose} />
    </div>
  );
}

function Toolbar({ data, filters, isPhone, loading, onPreset, onToggle, onUploads, onClear, onJump }: {
  data: TimelineData; filters: Filters; isPhone: boolean; loading: boolean;
  onPreset: (p: Preset) => void;
  onToggle: (key: "people" | "topics", id: string) => void;
  onUploads: (on: boolean) => void;
  onClear: () => void;
  onJump: (it: TimelineItem) => void;
}) {
  const [showAllTopics, setShowAllTopics] = useState(false);
  const topics = showAllTopics ? data.topics : data.topics.slice(0, 10);
  const anyFilter = filters.people.length > 0 || filters.topics.length > 0;
  // Keep chips for selected topics visible even when collapsed.
  const shownTopics = [...topics, ...data.topics.filter((t) => filters.topics.includes(t.id) && !topics.includes(t))];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {!isPhone && (
          <div role="group" aria-label="Show a range of time" className="inline-flex overflow-hidden rounded-md border border-line bg-surface">
            {PRESETS.map((p, i) => (
              <button key={p.key} type="button" onClick={() => onPreset(p.key)}
                className={clsx("px-3 py-1.5 text-sm hover:bg-surface-2", i > 0 && "border-l border-line")}>
                {p.label}
              </button>
            ))}
          </div>
        )}
        <SearchBox items={data.items} onJump={onJump} />
        <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-muted">
          <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={filters.uploads} onChange={(e) => onUploads(e.target.checked)} />
          Show uploads
        </label>
        {loading && <span className="text-xs text-muted" role="status">Updating…</span>}
      </div>

      {data.people.length > 0 && (
        <ChipRow label="People">
          {data.people.map((p) => (
            <Chip key={p.id} on={filters.people.includes(p.id)} onClick={() => onToggle("people", p.id)}>{p.label}</Chip>
          ))}
        </ChipRow>
      )}
      {data.topics.length > 0 && (
        <ChipRow label="Topics">
          {shownTopics.map((t) => (
            <Chip key={t.id} on={filters.topics.includes(t.id)} onClick={() => onToggle("topics", t.id)} tone="topic">{t.label}</Chip>
          ))}
          {data.topics.length > 10 && (
            <button type="button" className="px-1 text-xs font-medium text-accent hover:underline" onClick={() => setShowAllTopics((v) => !v)}>
              {showAllTopics ? "Fewer topics" : `All ${data.topics.length} topics`}
            </button>
          )}
        </ChipRow>
      )}
      {anyFilter && (
        <button type="button" onClick={onClear} className="text-xs font-medium text-accent hover:underline">Clear filters</button>
      )}
    </div>
  );
}

function ChipRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div role="group" aria-label={`Filter by ${label.toLowerCase()}`} className="flex items-start gap-2">
      <span className="w-14 shrink-0 pt-1 text-xs font-medium text-muted">{label}</span>
      <div className="flex min-w-0 flex-wrap gap-1.5">{children}</div>
    </div>
  );
}

function Chip({ on, onClick, children, tone = "person" }: { on: boolean; onClick: () => void; children: React.ReactNode; tone?: "person" | "topic" }) {
  const color = tone === "person" ? "var(--t-person)" : "var(--t-topic)";
  return (
    <button type="button" aria-pressed={on} onClick={onClick}
      className={clsx("rounded-full border px-2.5 py-1 text-xs font-medium transition", on ? "" : "bg-surface hover:bg-surface-2")}
      style={on ? { background: color, borderColor: color, color: "var(--surface)" } : { borderColor: "var(--line)", color }}>
      {children}
    </button>
  );
}

function SearchBox({ items, onJump }: { items: TimelineItem[]; onJump: (it: TimelineItem) => void }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const results = useMemo(() => searchItems(items, q, 8), [items, q]);
  const choose = (it: TimelineItem) => { onJump(it); setOpen(false); setQ(""); };

  return (
    <div className="relative min-w-[12rem] flex-1 sm:max-w-xs">
      <Search size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" aria-hidden="true" />
      <input
        type="search"
        role="combobox"
        aria-expanded={open && results.length > 0}
        aria-controls="timeline-search-results"
        aria-activedescendant={open && results[active] ? `tsr-${active}` : undefined}
        aria-autocomplete="list"
        aria-label="Find an event"
        placeholder="Find an event…"
        value={q}
        onChange={(e) => { setQ(e.target.value); setOpen(true); setActive(0); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, results.length - 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
          else if (e.key === "Enter" && results[active]) { e.preventDefault(); choose(results[active]); }
          else if (e.key === "Escape") setOpen(false);
        }}
        className="w-full rounded-md border border-line bg-surface py-1.5 pl-8 pr-3 text-sm placeholder:text-muted"
      />
      {open && q.trim() && (
        <ul id="timeline-search-results" role="listbox"
          className="absolute left-0 right-0 top-full z-40 mt-1 max-h-80 overflow-y-auto rounded-md border border-line bg-surface py-1 shadow-lg">
          {results.length === 0 && <li className="px-3 py-2 text-sm text-muted">No event called that.</li>}
          {results.map((it, i) => (
            <li key={it.id} id={`tsr-${i}`} role="option" aria-selected={i === active}
              onMouseDown={(e) => { e.preventDefault(); choose(it); }}
              onMouseEnter={() => setActive(i)}
              className={clsx("flex cursor-pointer items-start gap-2 px-3 py-2 text-sm", i === active && "bg-surface-2")}>
              <span className="mt-0.5"><ItemGlyph item={it} size={14} /></span>
              <span className="min-w-0">
                <span className="block truncate font-medium">{it.title}</span>
                <span className="block text-xs text-muted">{formatWhen(it.start, it.end, it.precision)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function TimelineSkeleton() {
  return (
    <div aria-busy="true" aria-live="polite" className="space-y-4">
      <span className="sr-only">Loading the timeline…</span>
      <div className="flex gap-2">
        <div className="h-8 w-56 animate-pulse rounded bg-surface-2" />
        <div className="h-8 w-48 animate-pulse rounded bg-surface-2" />
      </div>
      <div className="h-6 w-2/3 animate-pulse rounded bg-surface-2" />
      <div className="h-80 animate-pulse rounded-lg bg-surface-2" />
    </div>
  );
}
