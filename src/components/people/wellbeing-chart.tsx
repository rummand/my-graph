"use client";
import { extent, line, scaleLinear, scaleTime } from "d3";
import { useEffect, useMemo, useRef, useState } from "react";
import { WELLBEING_VAR, wellbeingBand, WELLBEING_WORDS } from "@/lib/people/circles";
import type { Observation } from "@/lib/people/types";
import { shortDate } from "./format";

const MARKER_LABEL: Record<string, string> = { contact: "In touch", milestone: "Milestone", health: "Health note", note: "Note" };

/**
 * Wellbeing over time: one line (scores 1–5, labelled with words) with a dot per check-in, and the other observations
 * (contact, milestones, notes) as markers on a strip underneath. Hover or focus a mark for its note.
 */
export function WellbeingChart({ observations }: { observations: Observation[] }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(280, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const scores = useMemo(() => observations.filter((o) => o.kind === "wellbeing" && o.score != null).sort((a, b) => a.at.localeCompare(b.at)), [observations]);
  const markers = useMemo(() => observations.filter((o) => o.kind !== "wellbeing").sort((a, b) => a.at.localeCompare(b.at)), [observations]);

  if (scores.length === 0) {
    return <p className="text-sm text-muted">No check-ins yet. Use “How are they?” to log the first one — the chart starts from there.</p>;
  }

  const height = 200;
  const m = { top: 12, right: 14, bottom: 46, left: 74 };
  const all = [...scores, ...markers].map((o) => new Date(o.at));
  const [lo, hi] = extent(all) as [Date, Date];
  const span = Math.max(hi.getTime() - lo.getTime(), 14 * 86400e3);
  const x = scaleTime().domain([new Date(hi.getTime() - span), hi]).range([m.left, width - m.right]).nice();
  const y = scaleLinear().domain([1, 5]).range([height - m.bottom, m.top]);
  const path = line<Observation>().x((o) => x(new Date(o.at))).y((o) => y(o.score!))(scores) ?? "";
  const stripY = height - m.bottom + 22;
  // keep tick labels inside the plot so the last one isn't clipped
  const ticks = x.ticks(Math.max(2, Math.floor((width - m.left) / 110))).filter((t) => x(t) >= m.left + 16 && x(t) <= width - m.right - 22);
  const fmtTick = x.tickFormat();
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
    <div ref={wrap} className="relative w-full">
      <svg width={width} height={height} role="group" aria-label={`Wellbeing over time, ${scores.length} check-ins`}>
        {[1, 2, 3, 4, 5].map((s) => (
          <g key={s} aria-hidden="true">
            <line x1={m.left} x2={width - m.right} y1={y(s)} y2={y(s)} stroke="var(--line)" strokeDasharray={s === 3 ? undefined : "2 4"} />
            <text x={m.left - 8} y={y(s)} dy="0.32em" textAnchor="end" fontSize={11} fill="var(--muted)">{WELLBEING_WORDS[s]}</text>
          </g>
        ))}
        {ticks.map((t) => (
          <text key={+t} x={x(t)} y={height - 4} textAnchor="middle" fontSize={11} fill="var(--muted)" aria-hidden="true">{fmtTick(t)}</text>
        ))}
        {markers.length > 0 && <line x1={m.left} x2={width - m.right} y1={stripY} y2={stripY} stroke="var(--line)" aria-hidden="true" />}
        <path d={path} fill="none" stroke="var(--t-person)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" aria-hidden="true" />
        {scores.map((o) => (
          <g key={o.id} {...markProps(o, `${shortDate(o.at)}: ${WELLBEING_WORDS[o.score!]}${o.note ? `. ${o.note}` : ""}`)}>
            <circle cx={x(new Date(o.at))} cy={y(o.score!)} r={12} fill="transparent" />
            <circle cx={x(new Date(o.at))} cy={y(o.score!)} r={active === o.id ? 6 : 4.5} fill={WELLBEING_VAR[wellbeingBand(o.score)]} stroke="var(--surface)" strokeWidth={2} />
          </g>
        ))}
        {markers.map((o) => {
          const cx = x(new Date(o.at));
          const label = `${shortDate(o.at)}: ${MARKER_LABEL[o.kind]}${o.note ? `. ${o.note}` : ""}`;
          return (
            <g key={o.id} {...markProps(o, label)}>
              <rect x={cx - 9} y={stripY - 9} width={18} height={18} fill="transparent" />
              {o.kind === "milestone"
                ? <path d={`M${cx},${stripY - 6} L${cx + 6},${stripY + 4} L${cx - 6},${stripY + 4} Z`} fill="var(--t-event)" stroke="var(--surface)" strokeWidth={1.5} />
                : o.kind === "contact"
                  ? <circle cx={cx} cy={stripY} r={4} fill="var(--accent)" stroke="var(--surface)" strokeWidth={1.5} />
                  : <rect x={cx - 4} y={stripY - 4} width={8} height={8} rx={1.5} fill="var(--t-topic)" stroke="var(--surface)" strokeWidth={1.5} />}
            </g>
          );
        })}
        {activeObs && <line x1={activeX} x2={activeX} y1={m.top} y2={stripY} stroke="var(--muted)" strokeDasharray="2 3" aria-hidden="true" pointerEvents="none" />}
      </svg>
      {activeObs && (
        <div role="tooltip" className="pointer-events-none absolute z-10 w-60 rounded-md border border-line bg-surface p-2.5 text-xs shadow-lg"
          style={{ left: Math.min(Math.max(activeX - 120, 0), width - 240), top: activeY + 14 }}>
          <div className="font-medium">{activeObs.kind === "wellbeing" ? WELLBEING_WORDS[activeObs.score!] : MARKER_LABEL[activeObs.kind]} <span className="font-normal text-muted">· {shortDate(activeObs.at)}</span></div>
          {activeObs.note && <p className="mt-1 text-fg">{activeObs.note}</p>}
          {activeObs.tags.length > 0 && <p className="mt-1 text-muted">{activeObs.tags.join(" · ")}</p>}
          {activeObs.authorName && <p className="mt-1 text-muted">By {activeObs.authorName}</p>}
        </div>
      )}
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted" aria-hidden="true">
        <span className="inline-flex items-center gap-1.5"><svg width="10" height="10"><circle cx="5" cy="5" r="4" fill="var(--accent)" /></svg>In touch</span>
        <span className="inline-flex items-center gap-1.5"><svg width="10" height="10"><path d="M5,0 L10,9 L0,9 Z" fill="var(--t-event)" /></svg>Milestone</span>
        <span className="inline-flex items-center gap-1.5"><svg width="10" height="10"><rect x="1" y="1" width="8" height="8" rx="1.5" fill="var(--t-topic)" /></svg>Note</span>
      </div>
      <details className="mt-2 text-xs">
        <summary className="cursor-pointer text-muted hover:text-fg">Show check-ins as a table</summary>
        <table className="mt-2 w-full text-left">
          <thead className="text-muted"><tr><th className="py-1 pr-3 font-medium">Date</th><th className="py-1 pr-3 font-medium">How</th><th className="py-1 font-medium">Note</th></tr></thead>
          <tbody>
            {[...scores].reverse().map((o) => (
              <tr key={o.id} className="border-t border-line"><td className="py-1 pr-3 whitespace-nowrap">{shortDate(o.at)}</td><td className="py-1 pr-3">{WELLBEING_WORDS[o.score!]} ({o.score})</td><td className="py-1">{o.note}</td></tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
