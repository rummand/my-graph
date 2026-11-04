"use client";
import { useMemo, useState, type CSSProperties } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight, Users } from "lucide-react";
import { clsx } from "clsx";
import { Avatar, IconButton } from "@/components/ui";
import { useLocale, useT, type Locale, type TFn } from "@/lib/i18n/client";
import { personStyle } from "@/lib/ui/person-color";
import { hrefs } from "./section";
import { buildWeek, monthName, weekDays, type Day, type Lane, type LaneWeek, type StripEvent, type StripItem, type StripReminder } from "./week";

const LABEL_COL = "176px";

/** Colour variables for a lane: the person's own hue, or quiet grey for the shared family row. */
function laneStyle(lane: Lane): CSSProperties {
  return (lane.colorId
    ? personStyle(lane.colorId)
    : { "--person": "var(--muted)", "--person-tint": "var(--surface-2)" }) as CSSProperties;
}

function rangeLabel(days: Day[], tz: string, t: TFn, locale: Locale): string {
  const a = days[0].date, b = days[6].date;
  const month = (d: Date) => monthName(d, tz, locale);
  return month(a) === month(b)
    ? t("today.week.rangeSameMonth", { from: days[0].dayOfMonth, to: days[6].dayOfMonth, mon: month(b) })
    : t("today.week.range", { from: days[0].dayOfMonth, fromMon: month(a), to: days[6].dayOfMonth, toMon: month(b) });
}

/**
 * The family week (family graphs only): the next seven days across, one row per child plus the whole family, each in their own colour.
 * Events are pale fills; things to do are outlined. On phones it turns into a sideways-scrolling list of days.
 */
export function WeekStrip({ lanes, family, events, reminders, eventsFailed, nowIso, tz, laneNote }: {
  lanes: Lane[]; family: Lane; events: StripEvent[]; reminders: StripReminder[]; eventsFailed: boolean;
  nowIso: string; tz: string; laneNote?: string | null;
}) {
  const t = useT();
  const locale = useLocale();
  const now = useMemo(() => new Date(nowIso), [nowIso]);
  const [offset, setOffset] = useState(0);
  const days = useMemo(() => weekDays(now, tz, offset, locale), [now, tz, offset, locale]);
  const rows = useMemo(
    () => buildWeek({ lanes, family, events, reminders, now, tz, offset, locale }),
    [lanes, family, events, reminders, now, tz, offset, locale],
  );
  const total = rows.reduce((n, r) => n + r.items.length, 0);
  const openFor = (lane: Lane) => reminders.filter((r) => !r.done && (lane.personNodeId
    ? r.aboutNodeId === lane.personNodeId
    : !lanes.some((l) => l.personNodeId && l.personNodeId === r.aboutNodeId))).length;

  return (
    <section aria-labelledby="week-title" className="min-w-0">
      <div className="mb-2.5 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex items-baseline gap-2.5">
          <h2 id="week-title" className="text-lg font-semibold tracking-[-0.01em]">{offset === 0 ? t("today.week.thisWeek") : t("today.week.nextWeek")}</h2>
          <span className="text-sm tabular-nums text-muted">{rangeLabel(days, tz, t, locale)}</span>
        </div>
        <div className="flex items-center gap-4">
          <Legend />
          <div className="flex items-center">
            <IconButton label={t("today.week.prev")} disabled={offset === 0} onClick={() => setOffset(0)}><ChevronLeft aria-hidden className="size-4" /></IconButton>
            <IconButton label={t("today.week.next")} disabled={offset === 7} onClick={() => setOffset(7)}><ChevronRight aria-hidden className="size-4" /></IconButton>
          </div>
        </div>
      </div>

      {eventsFailed && <p role="status" className="mb-2 text-sm text-warn">{t("today.week.calendarFailed")}</p>}
      {laneNote && <p role="status" className="mb-2 text-sm text-warn">{laneNote}</p>}

      <DesktopWeek days={days} rows={rows} openFor={openFor} empty={offset === 0 ? t("today.week.nothingThis") : t("today.week.nothingNext")} />
      <PhoneWeek days={days} rows={rows} />
      {rows.some((r) => r.next) && (
        <ul className="mt-3 space-y-1.5 text-sm md:hidden">
          {rows.filter((r) => r.next).map(({ lane, next }) => (
            <li key={lane.key} className="flex min-w-0 items-baseline gap-2" style={laneStyle(lane)}>
              <span aria-hidden className="size-2 shrink-0 translate-y-[-1px] rounded-full bg-[var(--person)]" />
              <span className="min-w-0 truncate"><span className="font-medium">{lane.name}</span> <span className="text-muted">{t("today.week.nextLower")}</span> {next!.label}, <span className="text-muted">{next!.when}</span></span>
            </li>
          ))}
        </ul>
      )}

      <p className="sr-only" aria-live="polite">{total === 0 ? t("today.week.srNothing") : t("today.week.srCount", { count: total })}</p>
    </section>
  );
}

function Legend() {
  const t = useT();
  return (
    <div className="hidden items-center gap-3 text-xs text-muted sm:flex" aria-hidden>
      <span className="flex items-center gap-1.5"><span className="h-3 w-5 rounded-[3px] bg-surface-2" />{t("today.week.event")}</span>
      <span className="flex items-center gap-1.5"><span className="h-3 w-5 rounded-[3px] ring-1 ring-inset ring-muted/60" />{t("today.week.todo")}</span>
    </div>
  );
}

function DayHeader({ d }: { d: Day }) {
  const t = useT();
  return (
    <div className={clsx("flex items-baseline gap-1.5 px-2 pb-2 pt-0.5", d.isWeekend && "text-muted")}>
      <span className={clsx("text-xs", d.isToday ? "font-semibold text-accent" : "text-muted")}>{d.isToday ? t("today.when.today") : d.weekday}</span>
      <span className={clsx("text-sm tabular-nums", d.isToday ? "font-semibold text-fg" : "font-medium")}>{d.dayOfMonth}</span>
    </div>
  );
}

function DesktopWeek({ days, rows, openFor, empty }: { days: Day[]; rows: LaneWeek[]; openFor: (lane: Lane) => number; empty: string }) {
  const t = useT();
  return (
    <div className="relative hidden rounded-lg bg-surface px-3 pb-1 pt-3 md:block">
      {/* Day columns: faint day lines, weekends one tone darker, today a cobalt line. */}
      <div aria-hidden className="pointer-events-none absolute inset-y-0 right-3 grid grid-cols-7" style={{ left: `calc(${LABEL_COL} + 0.75rem)` }}>
        {days.map((d) => (
          <div key={d.key} className={clsx("border-l", d.isToday ? "border-accent" : "border-line/70", d.isWeekend && "bg-surface-2/45")} />
        ))}
      </div>

      <div className="relative grid" style={{ gridTemplateColumns: `${LABEL_COL} minmax(0,1fr)` }}>
        <div />
        <div className="grid grid-cols-7">{days.map((d) => <DayHeader key={d.key} d={d} />)}</div>

        {rows.map(({ lane, items, next }) => (
          <div key={lane.key} className="contents">
            <LaneLabel lane={lane} open={openFor(lane)} />
            <div className="grid min-h-[52px] grid-flow-row-dense grid-cols-7 content-center gap-y-1 border-t border-line/70 py-2" style={laneStyle(lane)}>
              {items.map((it) => (
                <div key={`${it.kind}:${it.id}`} className="min-w-0 px-1" style={{ gridColumn: `${it.col + 1} / span ${it.span}` }}>
                  <ItemMark item={it} />
                </div>
              ))}
              {items.length === 0 && (
                <p className="col-span-7 truncate px-2 text-sm text-muted">
                  {next ? <span className="bg-surface pr-2">{empty}. {t("today.week.nextCap")} <span className="text-fg">{next.label}</span>, {next.when}</span> : <span className="bg-surface pr-2">{empty}</span>}
                </p>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function LaneLabel({ lane, open }: { lane: Lane; open: number }) {
  const t = useT();
  const sub = [lane.age, open > 0 ? t("today.week.openCount", { count: open }) : null].filter(Boolean).join(", ");
  return (
    <div className="flex min-w-0 items-center gap-2.5 border-t border-line/70 py-2 pr-3">
      {lane.colorId
        ? <Avatar id={lane.colorId} name={lane.name} size={30} />
        : <span aria-hidden className="inline-flex size-[30px] shrink-0 items-center justify-center rounded-full bg-surface-2 text-muted"><Users className="size-4" /></span>}
      <div className="min-w-0 leading-tight">
        {lane.href
          ? <Link href={lane.href} className="block truncate font-medium hover:underline">{lane.name}</Link>
          : <span className="block truncate font-medium">{lane.name}</span>}
        {sub && <span className="block truncate text-xs text-muted">{sub}</span>}
      </div>
    </div>
  );
}

/** One thing on the strip. An event is a pale fill in the person's colour; a to-do is an outline; overdue is amber. */
function ItemMark({ item, withDot = false }: { item: StripItem; withDot?: boolean }) {
  const t = useT();
  const cls = clsx(
    "flex h-6 min-w-0 items-center gap-1.5 rounded-[4px] px-1.5 text-xs font-medium transition-[filter] hover:brightness-95",
    item.overdue ? "bg-warn-tint text-warn"
      : item.kind === "event" ? "bg-[var(--person-tint)] text-[var(--person-ink)]"
        : "text-[var(--person-ink)] shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--person)_55%,transparent)]",
  );
  const title = `${item.label}${item.time ? `, ${item.time}` : ""}${item.overdue ? `, ${t("today.week.overdue")}` : ""}`;
  const body = (
    <>
      {withDot && <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-[var(--person)]" />}
      {item.time && <span className="shrink-0 tabular-nums">{item.time}</span>}
      <span className="truncate">{item.label}</span>
    </>
  );
  return item.kind === "event"
    ? <Link href={hrefs.node(item.id)} title={title} className={cls}>{body}</Link>
    : <a href={`#reminder-${item.id}`} title={`${title}. ${t("today.week.goToReminder")}`} className={cls}>{body}</a>;
}

function PhoneWeek({ days, rows }: { days: Day[]; rows: LaneWeek[] }) {
  const t = useT();
  return (
    <div className="-mx-4 overflow-x-auto px-4 [scrollbar-width:none] md:hidden">
      <ol className="flex snap-x snap-mandatory gap-2 pb-1">
        {days.map((d) => {
          const here = rows.flatMap(({ lane, items }) =>
            items.filter((it) => it.col <= d.index && d.index < it.col + it.span).map((it) => ({ lane, it })));
          return (
            <li key={d.key} className={clsx("w-[152px] shrink-0 snap-start rounded-lg p-2.5", d.isToday ? "bg-surface ring-1 ring-inset ring-accent/60" : d.isWeekend ? "bg-surface-2/70" : "bg-surface")}>
              <div className="flex items-baseline gap-1.5 pb-2">
                <span className={clsx("text-xs", d.isToday ? "font-semibold text-accent" : "text-muted")}>{d.isToday ? t("today.when.today") : d.weekday}</span>
                <span className="text-sm font-semibold tabular-nums">{d.dayOfMonth}</span>
              </div>
              {here.length === 0 ? <p className="text-xs text-muted">{t("today.week.nothingPlanned")}</p> : (
                <ul className="space-y-1">
                  {here.map(({ lane, it }) => (
                    <li key={`${lane.key}:${it.kind}:${it.id}`} style={laneStyle(lane)}><ItemMark item={it} withDot /></li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
