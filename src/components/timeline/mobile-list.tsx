"use client";
/** Phone layout (< 640px): a vertical list grouped by month, with a Today marker, opening the same drawer. */
import { useEffect, useMemo, useRef } from "react";
import { clsx } from "clsx";
import { formatWhen, groupByMonth } from "@/lib/timeline/pure";
import type { TimelineItem } from "@/lib/timeline/types";
import { ItemGlyph, STATUS_LABEL } from "./marks";
import { useNow } from "./hooks";

export function MobileList({ items, peopleById, selectedId, onSelect, scrollToId }: {
  items: TimelineItem[];
  peopleById: Map<string, string>;
  selectedId: string | null;
  onSelect: (item: TimelineItem) => void;
  /** Bring this item into view (search). */
  scrollToId: string | null;
}) {
  const now = useNow();
  const groups = useMemo(() => groupByMonth(items), [items]);
  const firstUpcoming = useMemo(() => [...items].sort((a, b) => a.start.localeCompare(b.start)).find((i) => new Date(i.start).getTime() >= now)?.id ?? null, [items, now]);
  const todayRef = useRef<HTMLLIElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const didInitialScroll = useRef(false);

  // Open near today the first time.
  useEffect(() => {
    if (didInitialScroll.current || !todayRef.current) return;
    didInitialScroll.current = true;
    todayRef.current.scrollIntoView({ block: "center" });
  }, [groups]);

  useEffect(() => {
    if (!scrollToId) return;
    listRef.current?.querySelector(`[data-item="${CSS.escape(scrollToId)}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [scrollToId]);

  const todayMarker = (
    <li ref={todayRef} className="flex items-center gap-2 py-2" aria-label="Today">
      <span className="rounded-full bg-accent px-2 py-0.5 text-[11px] font-semibold text-accent-fg">Today</span>
      <span className="h-0.5 flex-1 rounded bg-accent" aria-hidden="true" />
    </li>
  );

  return (
    <div ref={listRef} className="space-y-6">
      {groups.map((g) => (
        <section key={g.key} aria-labelledby={`m-${g.key}`}>
          <h2 id={`m-${g.key}`} className="sticky top-0 z-10 -mx-4 border-b border-line bg-bg/95 px-4 py-2 text-sm font-semibold backdrop-blur">
            {g.label}
          </h2>
          <ul className="mt-2 space-y-1.5">
            {g.items.map((it) => {
              const past = new Date(it.end ?? it.start).getTime() < now;
              const people = it.personIds.map((p) => peopleById.get(p)).filter(Boolean) as string[];
              return (
                <FragmentWithToday key={it.id} showToday={it.id === firstUpcoming} marker={todayMarker}>
                  <li data-item={it.id}>
                    <button type="button" onClick={() => onSelect(it)} aria-pressed={selectedId === it.id}
                      className={clsx(
                        "flex w-full items-start gap-3 rounded-lg border bg-surface px-3 py-2.5 text-left transition",
                        selectedId === it.id ? "border-accent ring-1 ring-accent" : "border-line hover:bg-surface-2",
                        past && "opacity-80",
                      )}>
                      <span className="mt-0.5"><ItemGlyph item={it} size={16} /></span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium leading-snug">{it.title}</span>
                        <span className="mt-0.5 block text-xs text-muted">
                          {it.kind === "reminder" ? "Due " : it.kind === "source" ? "Added " : ""}
                          {formatWhen(it.start, it.end, it.precision)}
                          {it.kind === "event" && it.status !== "confirmed" && <> · <span className={it.status === "inferred" ? "text-inferred" : undefined}>{STATUS_LABEL[it.status]}</span></>}
                          {it.overdue && <> · <span className="text-danger">Overdue</span></>}
                        </span>
                        {people.length > 0 && (
                          <span className="mt-1.5 flex flex-wrap gap-1">
                            {people.map((p) => <span key={p} className="rounded-full bg-accent-tint px-2 py-0.5 text-[11px] text-accent">{p}</span>)}
                          </span>
                        )}
                      </span>
                    </button>
                  </li>
                </FragmentWithToday>
              );
            })}
          </ul>
        </section>
      ))}
      {firstUpcoming === null && items.length > 0 && <ul>{todayMarker}</ul>}
    </div>
  );
}

function FragmentWithToday({ showToday, marker, children }: { showToday: boolean; marker: React.ReactNode; children: React.ReactNode }) {
  return <>{showToday && marker}{children}</>;
}
