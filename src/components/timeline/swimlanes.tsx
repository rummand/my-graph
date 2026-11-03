"use client";
/**
 * Desktop swimlane timeline: one lane per person (+ Family), d3-zoom for wheel/pinch/drag, React-rendered SVG.
 * Only marks inside the visible window (plus a margin) are laid out and rendered, so pan/zoom stays fast.
 */
import Link from "next/link";
import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type KeyboardEvent, type Ref } from "react";
import {
  scaleTime, select, timeDay, timeHour, timeMonday, timeMonth, timeYear, zoom, zoomIdentity, zoomTransform,
  type ZoomBehavior,
} from "d3";
import { Home } from "lucide-react";
import { clsx } from "clsx";
import {
  axisContext, chooseTickSpec, dataExtent, formatWhen, initials, isMajorTick, itemExtent, packLane, presetDomain,
  tickLabel, type PackInput, type Preset, type TickSpec,
} from "@/lib/timeline/pure";
import type { Lane, TimelineItem } from "@/lib/timeline/types";
import { BellGlyph, KIND_LABEL, STATUS_LABEL, diamond, reminderColor, statusPaint } from "./marks";
import { useMediaQuery, useNow, usePrefersReducedMotion, useWidth } from "./hooks";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const REF_SPAN = 365 * DAY;
const MIN_SPAN = 2 * HOUR;
const MAX_SPAN = 200 * 365 * DAY;
const AXIS_H = 46;
const ROW_H = 24;
const LANE_PAD = 12;
const MIN_LANE_H = 52;
const MAX_ROWS = 4;
const CHAR_W = 6.7;
const MAX_LABEL_W = 220;

export type SwimlaneHandle = {
  zoomToPreset: (p: Preset) => void;
  focusItem: (item: TimelineItem) => void;
};

type Shape = "point" | "span" | "fuzzy" | "reminder" | "source";

type Placed = {
  key: string;
  item: TimelineItem;
  laneId: string;
  shape: Shape;
  x0: number;
  x1: number;
  cx: number;
  /** Centre y within the lane. */
  cy: number;
  label: boolean;
  labelInside: boolean;
  past: boolean;
};

type LaneLayout = { lane: Lane; y: number; h: number; marks: Placed[] };

function intervalFor(spec: TickSpec) {
  const base = { hour: timeHour, day: timeDay, week: timeMonday, month: timeMonth, year: timeYear }[spec.unit];
  return (spec.step > 1 ? base.every(spec.step) : base) ?? base;
}

const laneSubtitle = (l: Lane) =>
  l.kind === "viewer" ? "You" : l.kind === "child" ? (l.birthYear ? `Born ${l.birthYear}` : "Child")
    : l.kind === "member" ? "Family member" : l.kind === "family" ? "Not tied to one person" : "";

export function Swimlanes({
  lanes, items, peopleById, selectedId, onSelect, initialPreset, ref,
}: {
  lanes: Lane[];
  items: TimelineItem[];
  peopleById: Map<string, string>;
  selectedId: string | null;
  onSelect: (item: TimelineItem) => void;
  initialPreset: Preset;
  ref?: Ref<SwimlaneHandle>;
}) {
  const now = useNow();
  const reduceMotion = usePrefersReducedMotion();
  const wide = useMediaQuery("(min-width: 900px)", true);
  const labelW = wide ? 184 : 136;

  const [plotEl, setPlotEl] = useState<HTMLDivElement | null>(null);
  const width = useWidth(plotEl);
  const [ref0] = useState(() => [Date.now() - REF_SPAN, Date.now()] as const);
  const [view, setView] = useState<[number, number] | null>(null);
  const viewRef = useRef<[number, number] | null>(null);
  const widthRef = useRef(0);
  const zoomRef = useRef<ZoomBehavior<HTMLDivElement, unknown> | null>(null);
  const rafRef = useRef(0);
  const [hover, setHover] = useState<Placed | null>(null);
  const [focusKey, setFocusKey] = useState<string | null>(null);

  const extent = useMemo(() => dataExtent(items), [items]);
  const extentRef = useRef(extent);
  extentRef.current = extent;

  const baseScale = useCallback(
    (w: number) => scaleTime().domain([new Date(ref0[0]), new Date(ref0[1])]).range([0, Math.max(1, w)]),
    [ref0],
  );

  /** Move the zoom so that [d0, d1] fills the plot. */
  const zoomToDomain = useCallback((d0: number, d1: number, animate: boolean) => {
    const el = plotEl, z = zoomRef.current, w = widthRef.current;
    if (!el || !z || w <= 0 || !(d1 > d0)) return;
    const b = baseScale(w);
    const k = w / (b(new Date(d1)) - b(new Date(d0)));
    const t = zoomIdentity.translate(-b(new Date(d0)) * k, 0).scale(k);
    const sel = select(el);
    if (animate && !reduceMotion) sel.transition().duration(450).call(z.transform, t);
    else sel.call(z.transform, t);
  }, [plotEl, baseScale, reduceMotion]);

  // d3-zoom: drag + pinch via d3; wheel handled below (vertical → zoom, horizontal → pan).
  useEffect(() => {
    if (!plotEl) return;
    const z = zoom<HTMLDivElement, unknown>()
      .scaleExtent([REF_SPAN / MAX_SPAN, REF_SPAN / MIN_SPAN])
      .clickDistance(4)
      .filter((ev: Event & { button?: number; ctrlKey?: boolean }) => ev.type !== "wheel" && !ev.ctrlKey && !ev.button)
      .on("zoom", (ev: { transform: ReturnType<typeof zoomTransform> }) => {
        const d = ev.transform.rescaleX(baseScale(widthRef.current)).domain();
        viewRef.current = [d[0].getTime(), d[1].getTime()];
        if (!rafRef.current) rafRef.current = requestAnimationFrame(() => { rafRef.current = 0; setView(viewRef.current); });
      });
    zoomRef.current = z;
    const sel = select(plotEl);
    sel.call(z).on("dblclick.zoom", null);

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 0.05 : e.deltaMode ? 1 : 0.002;
      if (e.ctrlKey || Math.abs(e.deltaY) >= Math.abs(e.deltaX)) {
        const r = plotEl.getBoundingClientRect();
        z.scaleBy(sel, Math.pow(2, -e.deltaY * unit * (e.ctrlKey ? 10 : 1)), [e.clientX - r.left, 0]);
      } else {
        z.translateBy(sel, -e.deltaX * (e.deltaMode === 1 ? 20 : 1) / zoomTransform(plotEl).k, 0);
      }
    };
    plotEl.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      plotEl.removeEventListener("wheel", onWheel);
      sel.on(".zoom", null);
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    };
  }, [plotEl, baseScale]);

  // First layout: open on the initial preset. On resize: keep the same window of time.
  useEffect(() => {
    if (width <= 0) return;
    widthRef.current = width;
    const v = viewRef.current;
    if (v) zoomToDomain(v[0], v[1], false);
    else {
      const [a, b] = presetDomain(initialPreset, new Date(), extentRef.current);
      zoomToDomain(a.getTime(), b.getTime(), false);
    }
  }, [width, zoomToDomain, initialPreset]);

  useImperativeHandle(ref, () => ({
    zoomToPreset: (p) => {
      const [a, b] = presetDomain(p, new Date(), extentRef.current);
      zoomToDomain(a.getTime(), b.getTime(), true);
    },
    focusItem: (item) => {
      const v = viewRef.current;
      const { t0, t1 } = itemExtent(item);
      const span = v ? v[1] - v[0] : 30 * DAY;
      if (t1 - t0 > span * 0.8) {
        const pad = (t1 - t0) * 0.1;
        zoomToDomain(t0 - pad, t1 + pad, true);
      } else {
        // Land a little left of centre: the details drawer opens over the right-hand side.
        const mid = (t0 + t1) / 2;
        zoomToDomain(mid - span * 0.35, mid + span * 0.65, true);
      }
      const laneId = item.laneIds[0];
      requestAnimationFrame(() => {
        document.querySelector(`[data-lane="${CSS.escape(laneId)}"]`)?.scrollIntoView({ block: "nearest", behavior: reduceMotion ? "auto" : "smooth" });
      });
    },
  }), [zoomToDomain, reduceMotion]);

  // ── Layout (memoised on the view; only visible items).
  const itemsByLane = useMemo(() => {
    const m = new Map<string, { item: TimelineItem; t0: number; t1: number; fuzzy: boolean }[]>();
    for (const it of items) {
      const e = itemExtent(it);
      for (const l of it.laneIds) (m.get(l) ?? m.set(l, []).get(l)!).push({ item: it, ...e });
    }
    return m;
  }, [items]);

  const x = useMemo(() => (view && width > 0 ? scaleTime().domain([new Date(view[0]), new Date(view[1])]).range([0, width]) : null), [view, width]);

  const layout = useMemo(() => {
    if (!x || !view) return null;
    const pxPerMs = width / (view[1] - view[0]);
    const winLo = view[0] - 260 / pxPerMs, winHi = view[1] + 20 / pxPerMs;
    let y = 0;
    const out: LaneLayout[] = [];
    for (const lane of lanes) {
      const all = itemsByLane.get(lane.id) ?? [];
      const vis = all.filter((e) => e.t1 >= winLo && e.t0 <= winHi);
      const dense = vis.length > 400;
      const geo = new Map<string, Omit<Placed, "cy" | "label" | "laneId" | "key">>();
      const pack: PackInput[] = [];
      for (const e of vis) {
        const it = e.item;
        let shape: Shape;
        let x0: number, x1: number, cx: number;
        if (it.kind === "reminder" || it.kind === "source") {
          shape = it.kind; cx = x(new Date(e.t0)); x0 = cx - 7; x1 = cx + 7;
        } else {
          const a = x(new Date(e.t0)), b = x(new Date(e.t1));
          if (e.fuzzy ? b - a >= 16 : it.end && b - a >= 3) {
            shape = e.fuzzy ? "fuzzy" : "span"; x0 = a; x1 = Math.max(b, a + 10); cx = a;
          } else {
            shape = "point"; cx = e.fuzzy ? (a + b) / 2 : a; x0 = cx - 7; x1 = cx + 7;
          }
        }
        const lw = Math.min(MAX_LABEL_W, it.title.length * CHAR_W + 4);
        const inside = (shape === "span" || shape === "fuzzy") && x1 - x0 >= lw + 16;
        geo.set(it.id, { item: it, shape, x0, x1, cx, labelInside: inside, past: e.t1 < now });
        pack.push({ id: it.id, x0, x1Bare: x1, x1Label: dense ? x1 : inside ? x1 : x1 + 6 + lw });
      }
      const res = packLane(pack, { gap: 6, maxRows: MAX_ROWS });
      const h = Math.max(MIN_LANE_H, res.rowCount * ROW_H + 2 * LANE_PAD);
      const marks: Placed[] = [];
      for (const p of pack) {
        const g = geo.get(p.id)!;
        const pl = res.placed.get(p.id)!;
        marks.push({ ...g, key: `${lane.id}|${p.id}`, laneId: lane.id, cy: LANE_PAD + pl.row * ROW_H + ROW_H / 2, label: pl.label && !dense });
      }
      // Spans first so points draw on top.
      marks.sort((a, b) => Number(a.shape === "point" || a.shape === "reminder") - Number(b.shape === "point" || b.shape === "reminder"));
      out.push({ lane, y, h, marks });
      y += h;
    }

    // Connectors between lanes for events involving several people.
    const byItem = new Map<string, { x: number; ys: number[] }>();
    for (const l of out) for (const m of l.marks) {
      if (m.item.laneIds.length < 2) continue;
      const e = byItem.get(m.item.id) ?? { x: m.shape === "point" ? m.cx : m.x0 + 5, ys: [] };
      e.ys.push(l.y + m.cy);
      byItem.set(m.item.id, e);
    }
    const connectors = [...byItem.entries()].filter(([, e]) => e.ys.length > 1)
      .map(([id, e]) => ({ id, x: e.x, y0: Math.min(...e.ys), y1: Math.max(...e.ys) }));

    const spec = chooseTickSpec(view[1] - view[0], width, 84);
    const ticks = intervalFor(spec).range(new Date(view[0] - 1), new Date(view[1] + 1))
      .map((d) => ({ d, x: x(d), major: isMajorTick(d, spec), label: tickLabel(d, spec) }));
    return { lanes: out, height: y, connectors, spec, ticks, visibleCount: out.reduce((n, l) => n + l.marks.length, 0) };
  }, [x, view, width, lanes, itemsByLane, now]);

  const nowX = x ? x(new Date(now)) : null;
  const showNow = nowX !== null && nowX >= -2 && nowX <= width + 2;

  // ── Keyboard: ←/→ pan, +/− zoom, T today.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = (e.target as HTMLElement).tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    const el = plotEl, z = zoomRef.current;
    if (!el || !z) return;
    const sel = select(el);
    const k = zoomTransform(el).k;
    const step = (fn: () => void) => { e.preventDefault(); fn(); };
    switch (e.key) {
      case "ArrowLeft": return step(() => z.translateBy(sel, (width * 0.2) / k, 0));
      case "ArrowRight": return step(() => z.translateBy(sel, -(width * 0.2) / k, 0));
      case "+": case "=": return step(() => z.scaleBy(reduceMotion ? sel : sel.transition().duration(200) as never, 1.6, [width / 2, 0]));
      case "-": case "_": return step(() => z.scaleBy(reduceMotion ? sel : sel.transition().duration(200) as never, 1 / 1.6, [width / 2, 0]));
      case "t": case "T": return step(() => {
        const v = viewRef.current; const span = v ? v[1] - v[0] : 30 * DAY; const n = Date.now();
        zoomToDomain(n - span / 2, n + span / 2, true);
      });
    }
  };

  const nearest = useMemo(() => {
    if (!view || !layout || layout.visibleCount > 0 || !items.length) return null;
    const mid = (view[0] + view[1]) / 2;
    let best: TimelineItem | null = null, bd = Infinity;
    for (const it of items) { const d = Math.abs(new Date(it.start).getTime() - mid); if (d < bd) { bd = d; best = it; } }
    return best;
  }, [view, layout, items]);

  const hoverPeople = hover ? hover.item.personIds.map((p) => peopleById.get(p)).filter(Boolean).join(", ") : "";

  return (
    <div
      className="relative rounded-lg border border-line bg-surface outline-none"
      tabIndex={0}
      onKeyDown={onKeyDown}
      role="group"
      aria-roledescription="timeline"
      aria-label="Timeline. Left and right arrows move in time, plus and minus zoom, T jumps to today. Tab to reach events."
    >
      <div className="grid" style={{ gridTemplateColumns: `${labelW}px minmax(0, 1fr)` }}>
        {/* Corner + lane labels */}
        <div className="border-r border-line">
          <div className="sticky top-0 z-20 flex items-end border-b border-line bg-surface px-3 pb-2 text-xs font-medium text-muted" style={{ height: AXIS_H }}>
            <span className="truncate">{layout && view ? axisContext(new Date(view[0] + (view[1] - view[0]) * 0.02), layout.spec) : ""}</span>
          </div>
          {(layout?.lanes ?? lanes.map((lane) => ({ lane, h: MIN_LANE_H }))).map(({ lane, h }, i) => (
            <div key={lane.id} data-lane={lane.id} style={{ height: h }}
              className={clsx("flex items-center gap-2 border-b border-line/60 px-3", i % 2 === 1 && "bg-surface-2/40")}>
              <span aria-hidden="true" className={clsx("grid size-7 shrink-0 place-items-center rounded-full text-[11px] font-semibold",
                lane.kind === "family" ? "bg-surface-2 text-muted" : "bg-accent-tint text-accent")}>
                {lane.kind === "family" ? <Home size={14} /> : initials(lane.label)}
              </span>
              <span className="min-w-0">
                {lane.kind === "family"
                  ? <span className="block truncate text-sm font-medium">{lane.label}</span>
                  : <Link href={`/people/${lane.id}`} className="block truncate text-sm font-medium hover:underline">{lane.label}</Link>}
                {laneSubtitle(lane) && <span className="block truncate text-[11px] text-muted">{laneSubtitle(lane)}</span>}
              </span>
            </div>
          ))}
        </div>

        {/* Plot: axis + lanes. d3-zoom is attached here. */}
        <div ref={setPlotEl} className="relative min-w-0 cursor-grab touch-none select-none active:cursor-grabbing">
          <svg className="sticky top-0 z-10 block bg-surface" width={width || "100%"} height={AXIS_H} aria-hidden="true">
            <line x1={0} x2={width} y1={AXIS_H - 0.5} y2={AXIS_H - 0.5} stroke="var(--line)" />
            {layout?.ticks.map((t) => (
              <g key={t.d.getTime()} transform={`translate(${t.x},0)`}>
                <line y1={AXIS_H - (t.major ? 12 : 7)} y2={AXIS_H} stroke={t.major ? "var(--muted)" : "var(--line)"} />
                <text x={4} y={AXIS_H - 16} fontSize={11} fill={t.major ? "var(--fg)" : "var(--muted)"} fontWeight={t.major ? 600 : 400}>{t.label}</text>
              </g>
            ))}
            {showNow && (
              <g transform={`translate(${nowX},0)`}>
                <rect x={-22} y={4} width={44} height={17} rx={8.5} fill="var(--accent)" />
                <text x={0} y={16} textAnchor="middle" fontSize={11} fontWeight={600} fill="var(--accent-fg)">Today</text>
                <line y1={21} y2={AXIS_H} stroke="var(--accent)" strokeWidth={2} />
              </g>
            )}
          </svg>

          {layout && (
            <svg className="block" width={width} height={Math.max(layout.height, MIN_LANE_H)} role="presentation">
              {/* Past is tinted very slightly. */}
              {nowX !== null && nowX > 0 && <rect x={0} y={0} width={Math.min(nowX, width)} height={layout.height} fill="var(--surface-2)" opacity={0.35} />}
              {layout.lanes.map((l, i) => (
                <g key={l.lane.id}>
                  {i % 2 === 1 && <rect x={0} y={l.y} width={width} height={l.h} fill="var(--surface-2)" opacity={0.25} />}
                  <line x1={0} x2={width} y1={l.y + l.h - 0.5} y2={l.y + l.h - 0.5} stroke="var(--line)" opacity={0.6} />
                </g>
              ))}
              {layout.ticks.map((t) => (
                <line key={t.d.getTime()} x1={t.x} x2={t.x} y1={0} y2={layout.height} stroke="var(--line)" opacity={t.major ? 0.9 : 0.45} />
              ))}
              {showNow && <line x1={nowX!} x2={nowX!} y1={0} y2={layout.height} stroke="var(--accent)" strokeWidth={2} />}

              {layout.connectors.map((c) => (
                <line key={c.id} x1={c.x} x2={c.x} y1={c.y0} y2={c.y1} stroke="var(--muted)" strokeOpacity={0.35} strokeWidth={1.5} strokeDasharray="1 3" strokeLinecap="round" />
              ))}

              {layout.lanes.map((l) => (
                <g key={l.lane.id} transform={`translate(0,${l.y})`}>
                  {l.marks.map((m) => (
                    <Mark key={m.key} m={m} width={width}
                      selected={selectedId === m.item.id}
                      focused={focusKey === m.key || hover?.key === m.key}
                      onSelect={onSelect}
                      onHover={(on) => setHover(on ? { ...m, cy: m.cy + l.y } : null)}
                      onFocusChange={(on) => { setFocusKey(on ? m.key : null); setHover(on ? { ...m, cy: m.cy + l.y } : null); }} />
                  ))}
                </g>
              ))}
            </svg>
          )}

          {hover && (
            <div role="tooltip" className="pointer-events-none absolute z-30 max-w-[280px] rounded-md border border-line bg-surface px-3 py-2 text-xs shadow-lg"
              style={{
                left: Math.min(Math.max(hover.cx + 14, 4), Math.max(4, width - 284)),
                top: AXIS_H + hover.cy + 14,
              }}>
              <p className="font-medium text-fg">{hover.item.title}</p>
              <p className="mt-0.5 text-muted">{formatWhen(hover.item.start, hover.item.end, hover.item.precision)}</p>
              {hoverPeople && <p className="mt-0.5 text-muted">{hoverPeople}</p>}
              <p className="mt-1 text-muted">{hover.item.kind === "event" ? STATUS_LABEL[hover.item.status] : KIND_LABEL[hover.item.kind]}{hover.item.overdue ? " · overdue" : ""}</p>
            </div>
          )}

          {nearest && (
            <div className="pointer-events-none absolute inset-x-0 flex justify-center" style={{ top: AXIS_H + 8 }}>
              <div className="pointer-events-auto flex flex-wrap items-center gap-2 rounded-full border border-line bg-surface px-3 py-1.5 text-xs shadow-sm">
                <span className="text-muted">Nothing in this stretch of time.</span>
                <button type="button" className="font-medium text-accent hover:underline"
                  onClick={() => { const { t0, t1 } = itemExtent(nearest); const v = viewRef.current!; const span = v[1] - v[0]; const mid = (t0 + t1) / 2; zoomToDomain(mid - span / 2, mid + span / 2, true); }}>
                  Go to nearest
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Mark({ m, width, selected, focused, onSelect, onHover, onFocusChange }: {
  m: Placed; width: number; selected: boolean; focused: boolean;
  onSelect: (it: TimelineItem) => void; onHover: (on: boolean) => void; onFocusChange: (on: boolean) => void;
}) {
  const it = m.item;
  const p = statusPaint(it.status);
  const when = formatWhen(it.start, it.end, it.precision);
  const aria = `${it.title}, ${when}. ${it.kind === "event" ? STATUS_LABEL[it.status] : KIND_LABEL[it.kind]}${it.overdue ? ", overdue" : ""}.`;
  const isBar = m.shape === "span" || m.shape === "fuzzy";
  // Keep labels of bars that start off-screen readable.
  const labelX = m.labelInside ? Math.max(m.x0, 0) + 8 : m.x1 + 6;
  const ring = selected ? "var(--accent)" : focused ? "var(--muted)" : null;

  return (
    <g
      data-mark=""
      role="button"
      tabIndex={m.x1 >= 0 && m.x0 <= width ? 0 : -1}
      aria-label={aria}
      aria-pressed={selected}
      className="cursor-pointer outline-none"
      opacity={m.past && !selected ? 0.72 : 1}
      onClick={(e) => { e.stopPropagation(); onSelect(it); }}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); onSelect(it); } }}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      onFocus={() => onFocusChange(true)}
      onBlur={() => onFocusChange(false)}
    >
      {/* Generous invisible hit area. */}
      <rect x={m.x0 - 4} y={m.cy - 11} width={Math.max(m.x1 - m.x0 + 8, 22)} height={22} fill="transparent" />
      {isBar && ring && <rect x={m.x0 - 3} y={m.cy - 9} width={m.x1 - m.x0 + 6} height={18} rx={9} fill="none" stroke={ring} strokeWidth={2} />}
      {!isBar && ring && <circle cx={m.cx} cy={m.cy} r={11} fill="none" stroke={ring} strokeWidth={2} />}

      {m.shape === "span" && (
        <rect x={m.x0} y={m.cy - 6} width={m.x1 - m.x0} height={12} rx={6}
          fill={p.fill} fillOpacity={it.status === "confirmed" ? 0.85 : 1} stroke={p.stroke} strokeWidth={p.strokeWidth} strokeDasharray={p.dash} />
      )}
      {m.shape === "fuzzy" && (
        <>
          <rect x={m.x0} y={m.cy - 6} width={m.x1 - m.x0} height={12} rx={6}
            fill={it.status === "inferred" ? "var(--inferred)" : "var(--t-event)"} fillOpacity={0.16}
            stroke={p.stroke} strokeOpacity={0.5} strokeDasharray={it.status === "confirmed" ? undefined : "2.5 2"} />
          <path d={diamond(m.x0 + 8, m.cy, 4.5)} fill={p.fill} stroke={p.stroke} strokeWidth={1.25} strokeDasharray={p.dash} />
        </>
      )}
      {m.shape === "point" && <path d={diamond(m.cx, m.cy, 6.5)} fill={p.fill} stroke={p.stroke} strokeWidth={p.strokeWidth} strokeDasharray={p.dash} />}
      {m.shape === "reminder" && <BellGlyph x={m.cx - 7} y={m.cy - 7} size={14} color={reminderColor(it)} />}
      {m.shape === "source" && <rect x={m.cx - 4.5} y={m.cy - 4.5} width={9} height={9} rx={2} fill="var(--t-document)" />}

      {m.label && labelX >= 0 && (
        <text x={labelX} y={m.cy + 4} fontSize={12}
          fill={m.labelInside && it.status === "confirmed" && m.shape === "span" ? "var(--accent-fg)" : "var(--fg)"}
          fontWeight={selected ? 600 : 500}>
          {it.title.length * CHAR_W + 4 > MAX_LABEL_W ? `${it.title.slice(0, Math.floor((MAX_LABEL_W - 12) / CHAR_W))}…` : it.title}
        </text>
      )}
    </g>
  );
}
