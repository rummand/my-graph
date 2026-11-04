"use client";
import { extent, line, scaleLinear, scaleTime, timeMonth } from "d3";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { AnimatePresence, motion } from "motion/react";
import { personStyle } from "@/lib/ui/person-color";
import { WELLBEING_VAR, wellbeingBand } from "@/lib/people/circles";
import type { Observation } from "@/lib/people/types";
import { wellbeingWord } from "@/lib/people/words";
import { useFmt } from "./format";

const MARKER_KEY: Record<string, string> = { contact: "people.chart.inTouch", milestone: "people.chart.milestone", health: "people.chart.health", note: "people.chart.note" };

/**
 * Wellbeing over time: one line in the person's own colour (scores 1–5, labelled with words), a dot per check-in that
 * turns red when it was low, and the other moments (contact, milestones, notes) as marks on a strip underneath.
 * Hover or focus a mark for its note.
 */
export function WellbeingChart({ personId, observations }: { personId: string; observations: Observation[] }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [active, setActive] = useState<string | null>(null);
  const f = useFmt();
  const { t, shortDate } = f;
  const W = (s: number) => wellbeingWord(t, s);
  const MARKER_LABEL = (k: string) => t(MARKER_KEY[k] ?? "people.chart.note");

  const scores = useMemo(() => observations.filter((o) => o.kind === "wellbeing" && o.score != null).sort((a, b) => a.at.localeCompare(b.at)), [observations]);
  const markers = useMemo(() => observations.filter((o) => o.kind !== "wellbeing").sort((a, b) => a.at.localeCompare(b.at)), [observations]);
  const hasScores = scores.length > 0;
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(280, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, [hasScores]);

  // Drawn after mount: the axis depends on today's date and the viewer's time zone, which the server can't know.
  if (scores.length > 0 && width === 0) return <div ref={wrap} className="h-[262px] w-full" aria-hidden="true" />;

  if (scores.length === 0) {
    return (
      <div ref={wrap} className="flex h-[140px] flex-col justify-center rounded-md bg-surface-2/50 px-5">
        <p className="font-medium">{t("people.chart.emptyTitle")}</p>
        <p className="mt-1 max-w-[52ch] text-sm text-muted">{t("people.chart.emptyBody")}</p>
      </div>
    );
  }

  const height = 224;
  const m = { top: 10, right: 12, bottom: 62, left: 70 };
  const all = [...scores, ...markers].map((o) => new Date(o.at));
  const [lo, hi] = extent(all) as [Date, Date];
  const end = new Date(Math.max(hi.getTime(), Date.now()));
  const span = Math.max(end.getTime() - lo.getTime(), 28 * 86400e3);
  const x = scaleTime().domain([new Date(end.getTime() - span * 1.04), end]).range([m.left, width - m.right]);
  const y = scaleLinear().domain([1, 5]).range([height - m.bottom, m.top]);
  const path = line<Observation>().x((o) => x(new Date(o.at))).y((o) => y(o.score!))(scores) ?? "";
  const stripY = height - m.bottom + 26;
  const months = timeMonth.range(x.domain()[0], x.domain()[1]).filter((t) => x(t) >= m.left + 8 && x(t) <= width - m.right - 24);
  const ticks = months.length > Math.floor((width - m.left) / 70) ? months.filter((_, i) => i % 2 === 0) : months;
  const activeObs = observations.find((o) => o.id === active);
  const activeX = activeObs ? x(new Date(activeObs.at)) : 0;
  const activeY = activeObs ? (activeObs.kind === "wellbeing" ? y(activeObs.score!) : stripY) : 0;

  const markProps = (o: Observation, label: string) => ({
    tabIndex: 0, role: "img" as const, "aria-label": label,
    onMouseEnter: () => setActive(o.id), onMouseLeave: () => setActive((a) => (a === o.id ? null : a)),
    onFocus: () => setActive(o.id), onBlur: () => setActive((a) => (a === o.id ? null : a)),
    className: "cursor-default outline-none focus-visible:[&>*:last-child]:stroke-[var(--fg)]",
  });

  return (
    <div ref={wrap} className="relative w-full" style={personStyle(personId) as CSSProperties}>
      <svg width={width} height={height} role="group" aria-label={t("people.chart.aria", { count: scores.length })} className="block">
        {[1, 2, 3, 4, 5].map((s) => (
          <g key={s} aria-hidden="true">
            <line x1={m.left} x2={width - m.right} y1={y(s)} y2={y(s)} stroke="var(--line)" strokeOpacity={s === 1 ? 1 : 0.55} />
            <text x={m.left - 10} y={y(s)} dy="0.32em" textAnchor="end" fontSize={12} fill="var(--muted)">{W(s)}</text>
          </g>
        ))}
        {ticks.map((d) => (
          <text key={+d} x={x(d)} y={height - 6} textAnchor="middle" fontSize={12} fill="var(--muted)" aria-hidden="true">
            {f.month(d, d.getMonth() === 0)}
          </text>
        ))}
        {markers.length > 0 && <text x={m.left - 10} y={stripY} dy="0.32em" textAnchor="end" fontSize={12} fill="var(--muted)" aria-hidden="true">{t("people.chart.moments")}</text>}
        <path d={path} fill="none" stroke="var(--person)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" aria-hidden="true" />
        {scores.map((o) => {
          const band = wellbeingBand(o.score);
          return (
            <g key={o.id} {...markProps(o, `${shortDate(o.at)}: ${W(o.score!)}${o.note ? `. ${o.note}` : ""}`)}>
              <circle cx={x(new Date(o.at))} cy={y(o.score!)} r={12} fill="transparent" />
              <circle cx={x(new Date(o.at))} cy={y(o.score!)} r={active === o.id ? 5.5 : 4} fill={band === "warn" ? WELLBEING_VAR.warn : "var(--person)"} stroke="var(--surface)" strokeWidth={2} />
            </g>
          );
        })}
        {markers.map((o) => {
          const cx = x(new Date(o.at));
          const label = `${shortDate(o.at)}: ${MARKER_LABEL(o.kind)}${o.note ? `. ${o.note}` : ""}`;
          return (
            <g key={o.id} {...markProps(o, label)}>
              <rect x={cx - 9} y={stripY - 9} width={18} height={18} fill="transparent" />
              {o.kind === "milestone"
                ? <path d={`M${cx},${stripY - 5.5} L${cx + 5.5},${stripY + 4} L${cx - 5.5},${stripY + 4} Z`} fill="var(--t-event)" stroke="var(--surface)" strokeWidth={1.5} />
                : o.kind === "contact"
                  ? <circle cx={cx} cy={stripY} r={4} fill="var(--person)" stroke="var(--surface)" strokeWidth={1.5} />
                  : <rect x={cx - 4} y={stripY - 4} width={8} height={8} rx={1.5} fill="var(--muted)" stroke="var(--surface)" strokeWidth={1.5} />}
            </g>
          );
        })}
        {activeObs && <line x1={activeX} x2={activeX} y1={m.top} y2={stripY} stroke="var(--muted)" strokeOpacity={0.5} aria-hidden="true" pointerEvents="none" />}
      </svg>
      <AnimatePresence>
        {activeObs && (
          <motion.div key={activeObs.id} role="tooltip" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, transition: { duration: 0.1 } }}
            transition={{ duration: 0.15, ease: [0.22, 1, 0.36, 1] }}
            className="pointer-events-none absolute z-10 w-60 rounded-lg bg-surface p-3 text-[13px] shadow-float"
            style={{ left: Math.min(Math.max(activeX - 120, 0), width - 240), top: activeY + 14 }}>
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-medium">{activeObs.kind === "wellbeing" ? W(activeObs.score!) : MARKER_LABEL(activeObs.kind)}</span>
              <span className="text-muted tabular-nums">{shortDate(activeObs.at)}</span>
            </div>
            {activeObs.note && <p className="mt-1 text-fg">{activeObs.note}</p>}
            {activeObs.tags.length > 0 && <p className="mt-1 text-muted">{activeObs.tags.map((x) => t(`people.tags.${x}`, undefined, x)).join(", ")}</p>}
            {activeObs.authorName && <p className="mt-1 text-muted">{activeObs.byViewer ? t("people.chart.byYou") : t("people.chart.by", { name: activeObs.authorName })}</p>}
          </motion.div>
        )}
      </AnimatePresence>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-[13px] text-muted">
        <div className="flex flex-wrap gap-x-4 gap-y-1" aria-hidden="true">
          <span className="inline-flex items-center gap-1.5"><svg width="10" height="10"><circle cx="5" cy="5" r="4" fill="var(--person)" /></svg>{t("people.chart.inTouch")}</span>
          <span className="inline-flex items-center gap-1.5"><svg width="10" height="10"><path d="M5,0.5 L10,9.5 L0,9.5 Z" fill="var(--t-event)" /></svg>{t("people.chart.milestone")}</span>
          <span className="inline-flex items-center gap-1.5"><svg width="10" height="10"><rect x="1" y="1" width="8" height="8" rx="1.5" fill="var(--muted)" /></svg>{t("people.chart.note")}</span>
        </div>
        <details className="group">
          <summary className="cursor-pointer list-none hover:text-fg">{t("people.chart.table")}</summary>
          <table className="mt-2 w-full min-w-[280px] text-left">
            <thead className="text-muted"><tr><th className="py-1 pr-3 font-normal">{t("people.chart.date")}</th><th className="py-1 pr-3 font-normal">{t("people.chart.how")}</th><th className="py-1 font-normal">{t("people.chart.note")}</th></tr></thead>
            <tbody className="text-fg">
              {[...scores].reverse().map((o) => (
                <tr key={o.id} className="border-t border-line"><td className="whitespace-nowrap py-1 pr-3 tabular-nums">{shortDate(o.at)}</td><td className="py-1 pr-3">{W(o.score!)}</td><td className="py-1">{o.note}</td></tr>
              ))}
            </tbody>
          </table>
        </details>
      </div>
    </div>
  );
}
