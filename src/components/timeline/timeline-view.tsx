"use client";
/** The timeline page body: range and search, people and topic filters, then swimlanes (desktop) or a list (phones). */
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { clsx } from "clsx";
import { Search } from "lucide-react";
import { Button, EmptyState, Tabs, buttonClass } from "@/components/ui";
import { personStyle } from "@/lib/ui/person-color";
import { useT } from "@/lib/i18n/client";
import { dataExtent, searchItems } from "@/lib/timeline/pure";
import type { TimelineData, TimelineItem } from "@/lib/timeline/types";
import { EventDrawer } from "./event-drawer";
import { useMediaQuery, useWhen } from "./hooks";
import { RANGES, matchRange, openingRange, type RangeKey } from "./layout";
import { ItemGlyph, MarkSwatch } from "./marks";
import { RebuildButton } from "./rebuild-button";
import { MobileList } from "./mobile-list";
import { Swimlanes, type SwimlaneHandle } from "./swimlanes";

type Filters = { people: string[]; topics: string[]; uploads: boolean; documents: boolean };
const NO_FILTERS: Filters = { people: [], topics: [], uploads: false, documents: true };

function queryString(f: Filters): string {
  const p = new URLSearchParams();
  if (f.people.length) p.set("people", f.people.join(","));
  if (f.topics.length) p.set("topics", f.topics.join(","));
  p.set("types", ["event", "reminder", ...(f.documents ? ["document"] : []), ...(f.uploads ? ["source"] : [])].join(","));
  return p.toString();
}

export function TimelineView({ initial, initialError, graphKind = null }: { initial: TimelineData | null; initialError?: string | null; graphKind?: string | null }) {
  const t = useT();
  const isPhone = useMediaQuery("(max-width: 639px)");
  const [data, setData] = useState<TimelineData | null>(initial);
  const [error, setError] = useState<string | null>(initialError ?? null);
  const [loading, setLoading] = useState(!initial && !initialError);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [reload, setReload] = useState(0);
  const [selected, setSelected] = useState<TimelineItem | null>(null);
  const [jumpId, setJumpId] = useState<string | null>(null);
  const [activeRange, setActiveRange] = useState<RangeKey | null>(null);
  const lanesRef = useRef<SwimlaneHandle>(null);
  const firstFetch = useRef(!!initial);

  useEffect(() => {
    if (firstFetch.current) { firstFetch.current = false; return; }
    const ac = new AbortController();
    setLoading(true);
    fetch(`/api/timeline?${queryString(filters)}`, { signal: ac.signal, headers: { accept: "application/json" } })
      .then(async (r) => {
        const body = await r.json().catch(() => null);
        if (!r.ok) throw new Error(body && typeof body.error === "string" ? body.error : t("timeline.loadFailed"));
        setData(body as TimelineData);
        setError(null);
      })
      .catch((err: unknown) => {
        if (ac.signal.aborted) return;
        setError(err instanceof Error && !/fetch/i.test(err.message) ? err.message : t("timeline.offline"));
      })
      .finally(() => { if (!ac.signal.aborted) setLoading(false); });
    return () => ac.abort();
  }, [filters, reload, t]);

  const peopleById = useMemo(() => new Map((data?.people ?? []).map((p) => [p.id, p.label])), [data]);
  const items = useMemo(() => data?.items ?? [], [data]);
  const extent = useMemo(() => dataExtent(items), [items]);

  // Keep the open drawer pointing at fresh data after a refetch (or close it if the item is gone).
  useEffect(() => {
    setSelected((s) => (s ? items.find((i) => i.id === s.id) ?? null : s));
  }, [items]);

  const initialRange = useMemo<RangeKey>(() => openingRange(items, Date.now()),
    // Only decided once, from the first data we have.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data === null]);

  const onSelect = useCallback((it: TimelineItem) => setSelected(it), []);
  const onClose = useCallback(() => setSelected(null), []);
  const onViewChange = useCallback((v: [number, number]) => setActiveRange(matchRange(v, Date.now(), extent)), [extent]);

  const jumpTo = (it: TimelineItem) => {
    setSelected(it);
    setJumpId(it.id);
    lanesRef.current?.focusItem(it);
  };

  const filtered = filters.people.length > 0 || filters.topics.length > 0;
  const toggle = (key: "people" | "topics", id: string) =>
    setFilters((f) => ({ ...f, [key]: f[key].includes(id) ? f[key].filter((x) => x !== id) : [...f[key], id] }));
  const clear = () => setFilters((f) => ({ ...NO_FILTERS, uploads: f.uploads, documents: f.documents }));
  const refresh = useCallback(() => setReload((n) => n + 1), []);

  if (!data && loading) return <TimelineSkeleton />;
  if (!data) {
    return (
      <div role="alert" className="rounded-lg bg-danger-tint px-5 py-4">
        <p className="font-medium text-danger">{t("timeline.didntLoad")}</p>
        <p className="mt-1 text-sm">{error ?? t("timeline.ourSide")}</p>
        <Button className="mt-3" variant="secondary" size="sm" onClick={() => setReload((n) => n + 1)}>{t("timeline.tryAgain")}</Button>
      </div>
    );
  }

  const nothingAtAll = items.length === 0 && !filtered;

  return (
    <div className="space-y-5">
      {nothingAtAll && !filters.uploads ? (
        <EmptyState title={t("timeline.empty.title")}
          action={
            <div className="flex flex-col items-center gap-3">
              <div className="flex flex-wrap justify-center gap-2">
                <Link href="/library" className={buttonClass("primary")}>{t("timeline.empty.upload")}</Link>
                <Link href="/wiki" className={buttonClass("secondary")}>{t("timeline.empty.wiki")}</Link>
              </div>
              <button type="button" className="text-sm font-medium text-accent hover:underline" onClick={() => setFilters((f) => ({ ...f, uploads: true }))}>
                {t("timeline.empty.showLibrary")}
              </button>
              <RebuildButton onDone={refresh} className="justify-center" />
            </div>
          }>
          {t("timeline.empty.body")}
        </EmptyState>
      ) : (
        <>
          <Toolbar
            data={data} filters={filters} isPhone={isPhone} loading={loading} activeRange={activeRange}
            onRange={(r) => lanesRef.current?.zoomToRange(r)}
            onToday={() => lanesRef.current?.goToday()}
            onToggle={toggle}
            onUploads={(uploads) => setFilters((f) => ({ ...f, uploads }))}
            onDocuments={(documents) => setFilters((f) => ({ ...f, documents }))}
            onRebuilt={refresh}
            onClear={clear}
            onJump={jumpTo}
          />

          {error && (
            <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-danger-tint px-4 py-2.5 text-sm">
              <span className="text-danger">{error}</span>
              <button type="button" className="font-medium text-fg underline-offset-2 hover:underline" onClick={() => setReload((n) => n + 1)}>{t("timeline.tryAgain")}</button>
            </div>
          )}
          {data.truncated && (
            <p className="rounded-lg bg-warn-tint px-4 py-2.5 text-sm text-warn">
              {t("timeline.truncated", { count: items.filter((i) => i.kind === "event").length })}
            </p>
          )}

          {items.length === 0 ? (
            <EmptyState title={t("timeline.empty.noMatchTitle")} action={<Button variant="secondary" onClick={clear}>{t("timeline.filters.clear")}</Button>}>
              {t("timeline.empty.noMatchBody")}
            </EmptyState>
          ) : (
            <div className={clsx("transition-opacity duration-150", loading && "opacity-60")} aria-busy={loading}>
              {isPhone ? (
                <MobileList items={items} peopleById={peopleById} selectedId={selected?.id ?? null} onSelect={onSelect} scrollToId={jumpId} />
              ) : (
                <Swimlanes ref={lanesRef} lanes={data.lanes} items={items} peopleById={peopleById}
                  selectedId={selected?.id ?? null} onSelect={onSelect} initialRange={initialRange} onViewChange={onViewChange} graphKind={graphKind} />
              )}
            </div>
          )}
        </>
      )}

      <EventDrawer item={selected} peopleById={peopleById} onClose={onClose} isPhone={isPhone} />
    </div>
  );
}

function Toolbar({ data, filters, isPhone, loading, activeRange, onRange, onToday, onToggle, onUploads, onDocuments, onRebuilt, onClear, onJump }: {
  data: TimelineData; filters: Filters; isPhone: boolean; loading: boolean; activeRange: RangeKey | null;
  onRange: (r: RangeKey) => void;
  onToday: () => void;
  onToggle: (key: "people" | "topics", id: string) => void;
  onUploads: (on: boolean) => void;
  onDocuments: (on: boolean) => void;
  onRebuilt: () => void;
  onClear: () => void;
  onJump: (it: TimelineItem) => void;
}) {
  const t = useT();
  const [showAllTopics, setShowAllTopics] = useState(false);
  const topics = showAllTopics ? data.topics : data.topics.slice(0, 8);
  const anyFilter = filters.people.length > 0 || filters.topics.length > 0;
  // Keep chips for chosen topics visible even when the list is folded.
  const shownTopics = [...topics, ...data.topics.filter((x) => filters.topics.includes(x.id) && !topics.includes(x))];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {!isPhone && (
          <>
            <Tabs<RangeKey | "custom"> items={RANGES.map((r) => ({ value: r.key, label: t(r.labelKey) }))} value={activeRange ?? "custom"} onSelect={(v) => v !== "custom" && onRange(v)} />
            <Button variant="ghost" size="md" onClick={onToday}>{t("timeline.today")}</Button>
          </>
        )}
        <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
          {loading && <span className="text-sm text-muted" role="status">{t("timeline.updating")}</span>}
          <SearchBox items={data.items} onJump={onJump} />
          <KindToggle on={filters.documents} onClick={() => onDocuments(!filters.documents)} kind="document" label={t("timeline.filters.documentsAndMail")} short={t("timeline.filters.documents")} />
          <button type="button" aria-pressed={filters.uploads} onClick={() => onUploads(!filters.uploads)}
            className={clsx("inline-flex h-9 shrink-0 items-center gap-2 rounded-md px-3 text-sm transition-colors",
              filters.uploads ? "bg-fg font-medium text-bg" : "bg-surface-2 text-fg hover:bg-line")}>
            <span style={{ "--muted": filters.uploads ? "var(--bg)" : "var(--muted)" } as CSSProperties} className="inline-flex"><MarkSwatch kind="upload" size={14} /></span>
            {t("timeline.filters.uploads")}
          </button>
        </div>
      </div>

      {!isPhone && <RebuildButton onDone={onRebuilt} className="-mt-1" />}

      {(data.people.length > 0 || data.topics.length > 0) && (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          {data.people.length > 0 && (
            <FilterGroup label={t("timeline.filters.people")} groupLabel={t("timeline.filters.showOnlyPeople")}>
              {data.people.map((p) => (
                <PersonToggle key={p.id} id={p.id} label={p.label} on={filters.people.includes(p.id)} onClick={() => onToggle("people", p.id)} />
              ))}
            </FilterGroup>
          )}
          {data.topics.length > 0 && (
            <FilterGroup label={t("timeline.filters.topics")} groupLabel={t("timeline.filters.showOnlyTopics")}>
              {shownTopics.map((x) => (
                <TopicToggle key={x.id} on={filters.topics.includes(x.id)} onClick={() => onToggle("topics", x.id)}>{x.label}</TopicToggle>
              ))}
              {data.topics.length > 8 && (
                <button type="button" className="px-1 text-sm font-medium text-accent hover:underline" onClick={() => setShowAllTopics((v) => !v)}>
                  {showAllTopics ? t("timeline.filters.fewer") : t("timeline.filters.all", { count: data.topics.length })}
                </button>
              )}
            </FilterGroup>
          )}
          {anyFilter && <button type="button" onClick={onClear} className="text-sm font-medium text-accent hover:underline">{t("timeline.filters.clear")}</button>}
        </div>
      )}
    </div>
  );
}

/** Show or hide a kind of mark (documents and mail), drawn with the mark itself. */
function KindToggle({ on, onClick, kind, label, short }: { on: boolean; onClick: () => void; kind: "document"; label: string; short: string }) {
  return (
    <button type="button" aria-pressed={on} onClick={onClick}
      className={clsx("inline-flex h-9 shrink-0 items-center gap-2 rounded-md px-3 text-sm transition-colors",
        on ? "bg-fg font-medium text-bg" : "bg-surface-2 text-fg hover:bg-line")}>
      <span style={{ "--person": on ? "var(--bg)" : "var(--muted)", "--person-tint": "transparent" } as CSSProperties} className="inline-flex"><MarkSwatch kind={kind} size={14} /></span>
      <span className="hidden sm:inline">{label}</span><span className="sm:hidden">{short}</span>
    </button>
  );
}

function FilterGroup({ label, groupLabel, children }: { label: string; groupLabel: string; children: ReactNode }) {
  return (
    <div role="group" aria-label={groupLabel}
      className="-mx-4 flex w-[calc(100%+32px)] min-w-0 items-center gap-1.5 overflow-x-auto px-4 [scrollbar-width:none] *:shrink-0 sm:mx-0 sm:w-auto sm:flex-wrap sm:overflow-visible sm:px-0">
      <span className="mr-1 text-sm text-muted">{label}</span>
      {children}
    </div>
  );
}

/** A person filter: their dot on grey when off, their own tint when on. */
function PersonToggle({ id, label, on, onClick }: { id: string; label: string; on: boolean; onClick: () => void }) {
  return (
    <button type="button" aria-pressed={on} onClick={onClick} style={personStyle(id) as CSSProperties}
      className={clsx("inline-flex h-7 items-center gap-1.5 rounded-full pl-2 pr-2.5 text-sm transition-colors active:scale-[0.97]",
        on ? "bg-[var(--person-tint)] font-medium text-[var(--person)] ring-1 ring-inset ring-[var(--person)]" : "bg-surface-2 text-fg hover:bg-line")}>
      <span className="size-2 rounded-full bg-[var(--person)]" aria-hidden="true" />
      {label}
    </button>
  );
}

function TopicToggle({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-pressed={on} onClick={onClick}
      className={clsx("inline-flex h-7 items-center rounded-full px-2.5 text-sm transition-colors active:scale-[0.97]",
        on ? "bg-fg font-medium text-bg" : "bg-surface-2 text-fg hover:bg-line")}>
      {children}
    </button>
  );
}

function SearchBox({ items, onJump }: { items: TimelineItem[]; onJump: (it: TimelineItem) => void }) {
  const t = useT();
  const w = useWhen();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const results = useMemo(() => searchItems(items, q, 8), [items, q]);
  const choose = (it: TimelineItem) => { onJump(it); setOpen(false); setQ(""); };

  return (
    <div className="relative min-w-0 flex-1 sm:max-w-72">
      <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" aria-hidden="true" />
      <input
        type="search"
        role="combobox"
        aria-expanded={open && results.length > 0}
        aria-controls="timeline-search-results"
        aria-activedescendant={open && results[active] ? `tsr-${active}` : undefined}
        aria-autocomplete="list"
        aria-label={t("timeline.search.label")}
        placeholder={t("timeline.search.placeholder")}
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
        className="h-9 w-full rounded-md bg-surface pl-9 pr-3 text-sm text-fg ring-1 ring-inset ring-line placeholder:text-muted/80 hover:ring-muted/40 focus:outline-none focus:ring-2 focus:ring-accent"
      />
      {open && q.trim() && (
        <ul id="timeline-search-results" role="listbox"
          className="absolute right-0 top-full z-40 mt-1.5 max-h-80 w-full min-w-72 overflow-y-auto rounded-lg bg-surface p-1.5 shadow-float">
          {results.length === 0 && <li className="px-2.5 py-2 text-sm text-muted">{t("timeline.search.none")}</li>}
          {results.map((it, i) => (
            <li key={it.id} id={`tsr-${i}`} role="option" aria-selected={i === active}
              onMouseDown={(e) => { e.preventDefault(); choose(it); }}
              onMouseEnter={() => setActive(i)}
              className={clsx("flex cursor-pointer items-start gap-2.5 rounded-md px-2.5 py-2 text-sm", i === active && "bg-surface-2")}>
              <span className="mt-0.5"><ItemGlyph item={it} personId={it.personIds[0]} size={15} /></span>
              <span className="min-w-0">
                <span className="block truncate font-medium">{it.title}</span>
                <span className="block text-muted">{w.when(it.start, it.end, it.precision)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function TimelineSkeleton() {
  const t = useT();
  return (
    <div aria-busy="true" aria-live="polite" className="space-y-5">
      <span className="sr-only">{t("timeline.loading")}</span>
      <div className="flex gap-2">
        <div className="h-9 w-80 animate-pulse rounded-md bg-surface-2" />
        <div className="ml-auto h-9 w-72 animate-pulse rounded-md bg-surface-2" />
      </div>
      <div className="h-7 w-1/2 animate-pulse rounded-full bg-surface-2" />
      <div className="h-[360px] animate-pulse rounded-lg bg-surface" />
    </div>
  );
}
