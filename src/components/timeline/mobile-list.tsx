"use client";
/** Phone layout (< 640px): a vertical list by month, a date column on the left, and a cobalt Today line. */
import { Fragment, useEffect, useMemo, useRef } from "react";
import { clsx } from "clsx";
import { format } from "date-fns";
import { calendarDay, effectivePrecision, formatWhen, groupByMonth } from "@/lib/timeline/pure";
import type { TimelineItem } from "@/lib/timeline/types";
import { PersonChip } from "@/components/ui";
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
  const todayRef = useRef<HTMLDivElement>(null);
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
    <div ref={todayRef} className="flex items-center gap-3 py-2" role="separator" aria-label={`Today, ${format(now, "EEEE d MMMM")}`}>
      <span className="text-sm"><span className="font-semibold">Today</span> {format(now, "EEE d MMM")}</span>
      <span className="h-px flex-1 bg-accent" aria-hidden="true" />
    </div>
  );

  return (
    <div ref={listRef} className="space-y-6">
      {groups.map((g) => (
        <section key={g.key} aria-labelledby={`m-${g.key}`}>
          <h2 id={`m-${g.key}`} className="sticky top-0 z-10 -mx-4 bg-bg px-4 pb-2 pt-1 text-lg font-semibold tracking-[-0.01em]">
            {g.label}
          </h2>
          <ul>
            {g.items.map((it) => {
              const past = new Date(it.end ?? it.start).getTime() < now;
              const people = it.personIds.map((id) => ({ id, name: peopleById.get(id) })).filter((p): p is { id: string; name: string } => !!p.name);
              const p = effectivePrecision(it.start, it.precision);
              const day = p === "minute" ? new Date(it.start) : calendarDay(it.start);
              const exactDay = p === "minute" || p === "day";
              const selected = selectedId === it.id;
              return (
                <Fragment key={it.id}>
                  {it.id === firstUpcoming && <li>{todayMarker}</li>}
                  <li data-item={it.id}>
                    <button type="button" onClick={() => onSelect(it)} aria-pressed={selected}
                      className={clsx("-mx-2 flex w-[calc(100%+16px)] items-start gap-3 rounded-lg px-2 py-3 text-left transition-colors active:bg-surface-2",
                        selected ? "bg-surface ring-1 ring-inset ring-fg/80" : "hover:bg-surface")}>
                      <span className={clsx("w-10 shrink-0 text-center tabular-nums", past && "text-muted")} aria-hidden="true">
                        {exactDay ? (
                          <>
                            <span className="block text-xs text-muted">{format(day, "EEE")}</span>
                            <span className="block text-xl font-semibold leading-tight">{format(day, "d")}</span>
                          </>
                        ) : <span className="block pt-1 text-xs text-muted">{p === "month" ? format(day, "MMM") : format(day, "yyyy")}</span>}
                      </span>
                      <span className="mt-1"><ItemGlyph item={it} personId={it.personIds[0]} size={15} /></span>
                      <span className="min-w-0 flex-1">
                        <span className={clsx("block font-medium leading-snug", past && "text-muted")}>{it.title}</span>
                        <span className="mt-0.5 block text-sm text-muted">
                          {it.kind === "reminder" ? "Due " : it.kind === "source" ? "Added " : ""}
                          {formatWhen(it.start, it.end, it.precision)}
                        </span>
                        {(it.overdue || (it.kind === "event" && it.status !== "confirmed")) && (
                          <span className={clsx("mt-0.5 block text-sm", it.overdue ? "text-danger" : it.status === "inferred" ? "text-inferred" : "text-warn")}>
                            {it.overdue ? "Overdue" : STATUS_LABEL[it.status]}
                          </span>
                        )}
                        {people.length > 0 && (
                          <span className="mt-2 flex flex-wrap gap-1">
                            {people.map((person) => <PersonChip key={person.id} id={person.id} name={person.name} className="text-xs" />)}
                          </span>
                        )}
                      </span>
                    </button>
                  </li>
                </Fragment>
              );
            })}
          </ul>
        </section>
      ))}
      {firstUpcoming === null && items.length > 0 && todayMarker}
    </div>
  );
}
