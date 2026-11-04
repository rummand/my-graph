"use client";
/**
 * Desktop timeline: people down a fixed left column, time across. d3-zoom drives wheel/pinch/drag; React renders SVG.
 * Only marks in the visible window are laid out. Labels are packed so they never collide (layout.ts): points that
 * share a day merge into a counted cluster, and a label that has no room is cut to fit or left to the tooltip.
 */
import Link from "next/link";
import {
  useCallback, useEffect, useId, useImperativeHandle, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type Ref,
} from "react";
import {
  scaleTime, select, timeDay, timeHour, timeMonday, timeMonth, timeYear, zoom, zoomIdentity, zoomTransform,
  type ZoomBehavior,
} from "d3";
import { Home, Users } from "lucide-react";
import { clsx } from "clsx";
import { Avatar, Kbd } from "@/components/ui";
import { useT, type TFn } from "@/lib/i18n/client";
import { chooseTickSpec, dataExtent, itemExtent, type TickSpec } from "@/lib/timeline/pure";
import type { Lane, TimelineItem } from "@/lib/timeline/types";
import {
  BarMark, ClusterMark, DocumentMark, HatchDef, KIND_LABEL, Legend, MailDot, PointMark, ReminderMark, STATUS_LABEL, ThreadMark, UploadMark, ItemGlyph, laneStyle,
  type MarkKind,
} from "./marks";
import { clusterPoints, fitText, laneTitle, packMarks, rangeDomain, type LaneMark, type RangeKey } from "./layout";
import { useMediaQuery, useNow, usePrefersReducedMotion, useWhen, useWidth } from "./hooks";
import { datePrefixKey, type When } from "./when";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const REF_SPAN = 365 * DAY;
const MIN_SPAN = 2 * HOUR;
const MAX_SPAN = 200 * 365 * DAY;
const AXIS_H = 52;
const ROW_H = 30;
const LANE_PAD = 9;
const MIN_LANE_H = 52;
const MAX_ROWS = 2;
const LABEL_FONT = 12;

export type SwimlaneHandle = {
  zoomToRange: (r: RangeKey) => void;
  goToday: () => void;
  focusItem: (item: TimelineItem) => void;
};

type Shape = "point" | "bar" | "fuzzy" | "reminder" | "source" | "cluster" | "document" | "mail" | "thread";
const BARLIKE = new Set<Shape>(["bar", "fuzzy", "thread"]);

type Placed = {
  key: string;
  laneId: string;
  shape: Shape;
  /** The item (first member for clusters). */
  item: TimelineItem;
  members: TimelineItem[];
  x0: number;
  x1: number;
  cx: number;
  cy: number;
  text: string | null;
  textW: number;
  labelAt: "inside" | "after" | "none";
  past: boolean;
  /** Threads: x of each message. */
  dots?: number[];
};

type LaneLayout = { lane: Lane; y: number; h: number; marks: Placed[] };

function intervalFor(spec: TickSpec) {
  const base = { hour: timeHour, day: timeDay, week: timeMonday, month: timeMonth, year: timeYear }[spec.unit];
  return (spec.step > 1 ? base.every(spec.step) : base) ?? base;
}

/** The bigger unit named in the axis's upper tier. */
function upperFor(spec: TickSpec) {
  switch (spec.unit) {
    case "hour": return { every: timeDay };
    case "day": case "week": return { every: timeMonth };
    case "month": return { every: timeYear };
    case "year": return null;
  }
}

/** The shared lane is "Family" in a family graph and "Everyone" in any other. */
export const sharedLaneLabel = (t: TFn, graphKind: string | null | undefined) =>
  t(graphKind === "family" ? "timeline.lanes.family" : "timeline.lanes.everyone");

/** The quiet line under a lane's name. "Child" and birth years only belong to family graphs. */
export function laneSubtitle(l: Lane, t: TFn, graphKind: string | null | undefined): string | null {
  switch (l.kind) {
    case "viewer": return t("timeline.lanes.you");
    case "child": return graphKind === "family" ? (l.birthYear ? t("timeline.lanes.born", { year: l.birthYear }) : t("timeline.lanes.child")) : null;
    case "member": return t("timeline.lanes.member");
    case "family": return t("timeline.lanes.shared");
    default: return null;
  }
}

/** Text width in px for the label font; canvas-measured, cached. */
function useMeasure() {
  const cache = useRef(new Map<string, number>());
  const ctx = useRef<CanvasRenderingContext2D | null>(null);
  return useCallback((s: string) => {
    const hit = cache.current.get(s);
    if (hit !== undefined) return hit;
    if (!ctx.current && typeof document !== "undefined") {
      ctx.current = document.createElement("canvas").getContext("2d");
      if (ctx.current) ctx.current.font = `500 ${LABEL_FONT}px ${getComputedStyle(document.body).fontFamily}`;
    }
    const w = ctx.current ? Math.ceil(ctx.current.measureText(s).width) : s.length * 6.6;
    cache.current.set(s, w);
    return w;
  }, []);
}

export function Swimlanes({
  lanes, items, peopleById, selectedId, onSelect, initialRange, onViewChange, graphKind = null, ref,
}: {
  lanes: Lane[];
  items: TimelineItem[];
  peopleById: Map<string, string>;
  selectedId: string | null;
  onSelect: (item: TimelineItem) => void;
  initialRange: RangeKey;
  onViewChange?: (view: [number, number]) => void;
  /** The current graph's kind: decides family-only wording. */
  graphKind?: string | null;
  ref?: Ref<SwimlaneHandle>;
}) {
  const t = useT();
  const w = useWhen();
  const now = useNow();
  const reduceMotion = usePrefersReducedMotion();
  const wide = useMediaQuery("(min-width: 1024px)", true);
  const labelW = wide ? 196 : 152;
  const measure = useMeasure();
  const hatchId = `tl-hatch-${useId().replace(/:/g, "")}`;

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
  const [openCluster, setOpenCluster] = useState<Placed | null>(null);

  const extent = useMemo(() => dataExtent(items), [items]);
  const extentRef = useRef(extent);
  extentRef.current = extent;

  useEffect(() => { if (view) onViewChange?.(view); }, [view, onViewChange]);

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
    if (animate && !reduceMotion) sel.transition().duration(320).call(z.transform, t);
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

  // First layout: open on the initial range. On resize: keep the same window of time.
  useEffect(() => {
    if (width <= 0) return;
    widthRef.current = width;
    const v = viewRef.current;
    if (v) zoomToDomain(v[0], v[1], false);
    else {
      const [a, b] = rangeDomain(initialRange, Date.now(), extentRef.current);
      zoomToDomain(a, b, false);
    }
  }, [width, zoomToDomain, initialRange]);

  const goToday = useCallback(() => {
    const v = viewRef.current; const span = v ? v[1] - v[0] : 30 * DAY; const n = Date.now();
    zoomToDomain(n - span * 0.25, n + span * 0.75, true);
  }, [zoomToDomain]);

  useImperativeHandle(ref, () => ({
    zoomToRange: (r) => {
      const [a, b] = rangeDomain(r, Date.now(), extentRef.current);
      zoomToDomain(a, b, true);
    },
    goToday,
    focusItem: (item) => {
      const v = viewRef.current;
      const { t0, t1 } = itemExtent(item);
      const span = v ? v[1] - v[0] : 30 * DAY;
      if (t1 - t0 > span * 0.8) {
        const pad = (t1 - t0) * 0.1;
        zoomToDomain(t0 - pad, t1 + pad, true);
      } else {
        // Land left of centre: the details drawer opens over the right-hand side.
        const mid = (t0 + t1) / 2;
        zoomToDomain(mid - span * 0.3, mid + span * 0.7, true);
      }
      const laneId = item.laneIds[0];
      requestAnimationFrame(() => {
        document.querySelector(`[data-lane="${CSS.escape(laneId)}"]`)?.scrollIntoView({ block: "nearest", behavior: reduceMotion ? "auto" : "smooth" });
      });
    },
  }), [zoomToDomain, goToday, reduceMotion]);

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
    const winLo = view[0] - 300 / pxPerMs, winHi = view[1] + 20 / pxPerMs;
    const kinds = new Set<MarkKind>();
    let y = 0;
    const out: LaneLayout[] = [];
    for (const lane of lanes) {
      const vis = (itemsByLane.get(lane.id) ?? []).filter((e) => e.t1 >= winLo && e.t0 <= winHi);
      const dense = vis.length > 300;
      const geo = new Map<string, { item: TimelineItem; shape: Shape; x0: number; x1: number; cx: number; text: string; past: boolean; dots?: number[] }>();
      const input: LaneMark[] = [];
      for (const e of vis) {
        const it = e.item;
        let shape: Shape, x0: number, x1: number, cx: number;
        let dots: number[] | undefined;
        const a = x(new Date(e.t0)), b = x(new Date(e.t1));
        if (it.kind === "reminder" || it.kind === "source" || it.kind === "document") {
          shape = it.kind; cx = a; x0 = cx - 8; x1 = cx + 8;
        } else if (it.kind === "thread") {
          if (it.end && b - a >= 10) {
            shape = "thread"; x0 = a; x1 = b; cx = a;
            dots = (it.thread?.messages ?? []).map((msg) => x(new Date(msg.at)));
          } else { shape = "mail"; cx = a; x0 = cx - 8; x1 = cx + 8; }
        } else if (e.fuzzy ? b - a >= 28 : it.end && b - a >= 8) {
          shape = e.fuzzy ? "fuzzy" : "bar"; x0 = a; x1 = b; cx = a;
        } else {
          shape = "point"; cx = e.fuzzy ? (a + b) / 2 : a; x0 = cx - 8; x1 = cx + 8;
        }
        const text = laneTitle(it.title, lane.label);
        kinds.add(shape === "fuzzy" ? "fuzzy" : shape === "bar" ? (it.status === "confirmed" ? "span" : it.status)
          : shape === "reminder" ? (it.overdue ? "overdue" : "reminder") : shape === "source" ? "upload"
            : shape === "document" ? "document" : shape === "mail" || shape === "thread" ? "mail" : it.status);
        geo.set(it.id, { item: it, shape, x0, x1, cx, text, past: e.t1 < now, dots });
        input.push({ id: it.id, x0, x1, bar: BARLIKE.has(shape), labelW: dense ? 0 : measure(text) });
      }
      const { marks: merged, clusters } = clusterPoints(input, 14);
      const clusterText = new Map<string, string>();
      for (const c of clusters) {
        const titles = [...new Set(c.memberIds.map((id) => geo.get(id)!.text))];
        const label = titles.length === 1 ? titles[0] : t("timeline.lanesView.andMore", { first: titles[0], count: titles.length - 1 });
        clusterText.set(c.id, label);
        const m = merged.find((x) => x.id === c.id);
        if (m && !dense) m.labelW = measure(label);
      }
      const { placed, rows } = packMarks(merged, MAX_ROWS);
      const h = Math.max(MIN_LANE_H, rows * ROW_H + 2 * LANE_PAD);
      const top = (h - rows * ROW_H) / 2;
      const marks: Placed[] = [];
      for (const m of merged) {
        const p = placed.get(m.id)!;
        const cy = top + p.row * ROW_H + ROW_H / 2;
        const cluster = clusters.find((c) => c.id === m.id);
        if (cluster) {
          const members = cluster.memberIds.map((id) => geo.get(id)!.item);
          const cx = (cluster.x0 + cluster.x1) / 2;
          const text = p.label.at !== "none" ? fitText(clusterText.get(m.id)!, Math.min(p.label.room, width - (m.x1 + 6) - 4), measure) : null;
          marks.push({ key: `${lane.id}|${m.id}`, laneId: lane.id, shape: "cluster", item: members[0], members, x0: cx - 11, x1: cx + 11, cx, cy, text, textW: text ? measure(text) : 0, labelAt: text ? "after" : "none", past: members.every((it) => geo.get(it.id)!.past) });
          continue;
        }
        const g = geo.get(m.id)!;
        let text: string | null = null;
        let room = p.label.room;
        if (p.label.at === "inside") room = Math.min(room, Math.min(g.x1, width) - Math.max(g.x0, 0) - 16);
        // Cut a label at the plot's right edge rather than letting the edge clip it mid-letter.
        else if (p.label.at === "after" && g.x1 < width) room = Math.min(room, width - (g.x1 + 6) - 4);
        if (p.label.at !== "none" && room > 0) text = fitText(g.text, room, measure);
        marks.push({ key: `${lane.id}|${m.id}`, laneId: lane.id, shape: g.shape, item: g.item, members: [g.item], x0: g.x0, x1: g.x1, cx: g.cx, cy, text, textW: text ? measure(text) : 0, labelAt: text ? p.label.at : "none", past: g.past, dots: g.dots });
      }
      // Bars first so points draw on top.
      marks.sort((a, b) => Number(!BARLIKE.has(a.shape)) - Number(!BARLIKE.has(b.shape)));
      out.push({ lane, y, h, marks });
      y += h;
    }

    // Connectors between lanes for an event that involves several people.
    const byItem = new Map<string, { x: number; ys: number[] }>();
    for (const l of out) for (const m of l.marks) {
      if (m.shape === "cluster" || m.item.laneIds.length < 2) continue;
      const e = byItem.get(m.item.id) ?? { x: m.shape === "bar" || m.shape === "fuzzy" ? m.x0 + 1.5 : m.cx, ys: [] };
      if (m.shape === "thread") e.x = m.dots?.[0] ?? m.x0;
      e.ys.push(l.y + m.cy);
      byItem.set(m.item.id, e);
    }
    const connectors = [...byItem.entries()].filter(([, e]) => e.ys.length > 1)
      .map(([id, e]) => ({ id, x: e.x, y0: Math.min(...e.ys), y1: Math.max(...e.ys) }));

    const spec = chooseTickSpec(view[1] - view[0], width, 64);
    const ticks = intervalFor(spec).range(new Date(view[0] - 1), new Date(view[1] + 1))
      .map((d) => ({ d, x: x(d), label: spec.unit === "month" ? w.fmt(d, "monthShort") : w.tick(d, spec) }));

    // Upper tier: months (or years, or days), each label pinned to the left edge while its period is on screen.
    const up = upperFor(spec);
    const uppers: { key: number; x: number; label: string; boundary: boolean }[] = [];
    if (up) {
      const starts = up.every.range(up.every.floor(new Date(view[0])), new Date(view[1] + 1));
      starts.forEach((d, i) => {
        const sx = x(d);
        const next = starts[i + 1] ? x(starts[i + 1]) : Infinity;
        const label = w.upper(d, spec.unit);
        const lw = measure(label) + 16;
        uppers.push({ key: d.getTime(), x: Math.min(Math.max(sx, 0), next - lw, width - lw), label, boundary: sx > 0 });
      });
    }

    // Weekends, once a day is wide enough to see.
    const pxPerDay = DAY * pxPerMs;
    const weekends = pxPerDay >= 5
      ? timeDay.range(timeDay.floor(new Date(view[0])), new Date(view[1] + DAY))
        .filter((d) => d.getDay() === 6)
        .map((d) => ({ key: d.getTime(), x0: x(d), x1: x(timeDay.offset(d, 2)) }))
      : [];
    const dayLines = pxPerDay >= 12 && spec.unit !== "day" && spec.unit !== "hour"
      ? timeDay.range(new Date(view[0]), new Date(view[1] + 1)).map((d) => ({ key: d.getTime(), x: x(d) }))
      : [];

    return { lanes: out, height: y, connectors, ticks, uppers, weekends, dayLines, kinds, visibleCount: out.reduce((n, l) => n + l.marks.length, 0) };
  }, [x, view, width, lanes, itemsByLane, now, measure, t, w]);

  const nowX = x ? x(new Date(now)) : null;
  const showNow = nowX !== null && nowX >= -2 && nowX <= width + 2;
  const todayLabel = `${t("timeline.today")} ${w.fmt(now, "short")}`;
  const todayW = measure(todayLabel) + 12;

  // Close the cluster list when the view moves.
  useEffect(() => { setOpenCluster(null); }, [view]);

  // ── Keyboard: ←/→ pan, +/− zoom, T today. No animation for repeated keys.
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
      case "+": case "=": return step(() => z.scaleBy(sel, 1.6, [width / 2, 0]));
      case "-": case "_": return step(() => z.scaleBy(sel, 1 / 1.6, [width / 2, 0]));
      case "t": case "T": return step(goToday);
      case "Escape": if (openCluster) return step(() => setOpenCluster(null)); return;
    }
  };

  const nearest = useMemo(() => {
    if (!view || !layout || layout.visibleCount > 0 || !items.length) return null;
    const mid = (view[0] + view[1]) / 2;
    let best: TimelineItem | null = null, bd = Infinity;
    for (const it of items) { const d = Math.abs(new Date(it.start).getTime() - mid); if (d < bd) { bd = d; best = it; } }
    return best;
  }, [view, layout, items]);

  const rangeText = view ? w.range(view[0], view[1]) : "";

  return (
    <div className="space-y-4">
      <div
        className="relative rounded-lg bg-surface outline-none focus-visible:outline-2 focus-visible:outline-accent"
        tabIndex={0}
        onKeyDown={onKeyDown}
        role="group"
        aria-roledescription="timeline"
        aria-label={t("timeline.lanesView.label")}
      >
        <div className="grid" style={{ gridTemplateColumns: `${labelW}px minmax(0, 1fr)` }}>
          {/* People column */}
          <div>
            <div className="flex items-end px-4 pb-2.5 text-sm text-muted" style={{ height: AXIS_H }}>
              <span className="truncate" aria-live="polite">{rangeText}</span>
            </div>
            {(layout?.lanes ?? lanes.map((lane) => ({ lane, h: MIN_LANE_H }))).map(({ lane, h }) => {
              const subtitle = laneSubtitle(lane, t, graphKind);
              return (
              <div key={lane.id} data-lane={lane.id} style={{ height: h }} className="flex items-center gap-2.5 border-t border-line/70 px-4">
                {lane.kind === "family"
                  ? <span aria-hidden="true" className="grid size-7 shrink-0 place-items-center rounded-full bg-surface-2 text-muted">{graphKind === "family" ? <Home size={14} /> : <Users size={14} />}</span>
                  : <Avatar id={lane.id} name={lane.label} size={28} />}
                <span className="min-w-0 leading-tight">
                  {lane.kind === "family"
                    ? <span className="block truncate text-sm font-medium">{sharedLaneLabel(t, graphKind)}</span>
                    : <Link href={`/people/${lane.id}`} className="block truncate text-sm font-medium hover:underline">{lane.label}</Link>}
                  {subtitle && <span className="mt-0.5 block truncate text-xs text-muted">{subtitle}</span>}
                </span>
              </div>
              );
            })}
          </div>

          {/* Plot: axis + lanes. d3-zoom is attached here. */}
          <div ref={setPlotEl} className="relative min-w-0 cursor-grab touch-none select-none overflow-hidden rounded-r-lg active:cursor-grabbing">
            <svg className="block" width={width || "100%"} height={AXIS_H} aria-hidden="true" style={{ fontVariantNumeric: "tabular-nums" }}>
              {layout?.uppers.map((u) => (
                <g key={u.key}>
                  {u.boundary && <line x1={x!(new Date(u.key))} x2={x!(new Date(u.key))} y1={10} y2={AXIS_H} stroke="var(--line)" />}
                  <text x={u.x + 6} y={22} fontSize={13} fontWeight={600} fill="var(--fg)">{u.label}</text>
                </g>
              ))}
              {layout?.ticks.map((t) => {
                const hidden = showNow && t.x + 40 > nowX! - 4 && t.x < nowX! + todayW + 2;
                return hidden ? null : <text key={t.d.getTime()} x={t.x + 6} y={AXIS_H - 12} fontSize={11.5} fill="var(--muted)">{t.label}</text>;
              })}
              {showNow && (
                <g transform={`translate(${nowX},0)`}>
                  <rect x={0} y={AXIS_H - 26} width={todayW} height={20} fill="var(--surface)" />
                  <text x={6} y={AXIS_H - 12} fontSize={12} fill="var(--fg)"><tspan fontWeight={600}>{t("timeline.today")}</tspan><tspan dx={4}>{w.fmt(now, "short")}</tspan></text>
                  <line x1={0.5} x2={0.5} y1={AXIS_H - 26} y2={AXIS_H} stroke="var(--accent)" />
                </g>
              )}
            </svg>

            {layout && (
              <svg className="block" width={width} height={Math.max(layout.height, MIN_LANE_H)} role="presentation" style={{ fontVariantNumeric: "tabular-nums" }}>
                <defs><HatchDef id={hatchId} /></defs>
                {layout.weekends.map((w) => (
                  <rect key={w.key} x={w.x0} y={0} width={Math.max(0, w.x1 - w.x0)} height={layout.height} fill="var(--surface-2)" opacity={0.45} />
                ))}
                {layout.dayLines.map((d) => <line key={d.key} x1={d.x} x2={d.x} y1={0} y2={layout.height} stroke="var(--line)" strokeOpacity={0.4} />)}
                {layout.ticks.map((t) => <line key={t.d.getTime()} x1={t.x} x2={t.x} y1={0} y2={layout.height} stroke="var(--line)" />)}
                {layout.uppers.filter((u) => u.boundary).map((u) => {
                  const ux = x!(new Date(u.key));
                  return <line key={u.key} x1={ux} x2={ux} y1={0} y2={layout.height} stroke="var(--muted)" strokeOpacity={0.35} />;
                })}
                {layout.lanes.map((l) => <line key={l.lane.id} x1={0} x2={width} y1={l.y + 0.5} y2={l.y + 0.5} stroke="var(--line)" strokeOpacity={0.7} />)}
                {showNow && <line x1={nowX! + 0.5} x2={nowX! + 0.5} y1={0} y2={layout.height} stroke="var(--accent)" />}

                {layout.connectors.map((c) => (
                  <line key={c.id} x1={c.x} x2={c.x} y1={c.y0 + 9} y2={c.y1 - 9} stroke="var(--muted)" strokeOpacity={0.45} strokeWidth={1.25} strokeDasharray="0.1 3.5" strokeLinecap="round" />
                ))}

                {layout.lanes.map((l) => (
                  <g key={l.lane.id} transform={`translate(0,${l.y})`} style={laneStyle(l.lane.id)}>
                    {l.marks.map((m) => (
                      <Mark key={m.key} m={m} width={width} hatchId={hatchId}
                        selected={m.members.some((it) => it.id === selectedId)}
                        focused={focusKey === m.key}
                        hovered={hover?.key === m.key}
                        onActivate={() => (m.shape === "cluster" ? setOpenCluster((o) => (o?.key === m.key ? null : { ...m, cy: m.cy + l.y })) : onSelect(m.item))}
                        onHover={(on) => setHover(on ? { ...m, cy: m.cy + l.y } : null)}
                        onFocusChange={(on) => { setFocusKey(on ? m.key : null); setHover(on ? { ...m, cy: m.cy + l.y } : null); }} />
                    ))}
                  </g>
                ))}
              </svg>
            )}

            {hover && !openCluster && <Tooltip m={hover} width={width} peopleById={peopleById} />}

            {openCluster && (
              <ClusterList m={openCluster} width={width} selectedId={selectedId}
                onPick={(it) => { setOpenCluster(null); onSelect(it); }} onClose={() => setOpenCluster(null)} />
            )}

            {nearest && (
              <div className="pointer-events-none absolute inset-x-0 flex justify-center" style={{ top: AXIS_H + 12 }}>
                <div className="pointer-events-auto flex items-center gap-3 rounded-full bg-surface py-1.5 pl-4 pr-1.5 text-sm shadow-float">
                  <span className="text-muted">{t("timeline.lanesView.nothingHere")}</span>
                  <button type="button" className="rounded-full bg-surface-2 px-3 py-1 font-medium hover:bg-line"
                    onClick={() => { const { t0, t1 } = itemExtent(nearest); const v = viewRef.current!; const span = v[1] - v[0]; const mid = (t0 + t1) / 2; zoomToDomain(mid - span / 2, mid + span / 2, true); }}>
                    {t("timeline.lanesView.goNearest")}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-8 gap-y-3">
        {layout && <Legend kinds={layout.kinds} />}
        <p className="flex flex-wrap items-center gap-1.5 text-sm text-muted">
          {t("timeline.lanesView.helpDrag")} <Kbd>←</Kbd><Kbd>→</Kbd> {t("timeline.lanesView.helpMove")} <Kbd>+</Kbd><Kbd>−</Kbd> {t("timeline.lanesView.helpZoom")} <Kbd>T</Kbd> {t("timeline.lanesView.helpToday")}
        </p>
      </div>
    </div>
  );
}

function Mark({ m, width, hatchId, selected, focused, hovered, onActivate, onHover, onFocusChange }: {
  m: Placed; width: number; hatchId: string; selected: boolean; focused: boolean; hovered: boolean;
  onActivate: () => void; onHover: (on: boolean) => void; onFocusChange: (on: boolean) => void;
}) {
  const t = useT();
  const w = useWhen();
  const it = m.item;
  const isBar = BARLIKE.has(m.shape);
  const isThread = m.shape === "thread";
  const aria = m.shape === "cluster"
    ? t("timeline.lanesView.clusterAria", { count: m.members.length, date: w.fmt(it.start, "dayMonth") })
    : markAria(it, t, w);
  const labelX = m.labelAt === "inside" ? Math.max(m.x0, 0) + (isThread ? 2 : 9) : m.x1 + 6;
  // A conversation's line runs under its label, so the text sits above it.
  const labelY = isThread && m.labelAt === "inside" ? m.cy - 3 : m.cy + 4;
  const lineY = isThread && m.labelAt === "inside" ? m.cy + 7 : m.cy;
  const ring = focused ? "var(--accent)" : selected ? "var(--fg)" : null;
  const dim = m.past && !selected && !hovered;

  return (
    <g
      role="button"
      tabIndex={m.x1 >= 0 && m.x0 <= width ? 0 : -1}
      aria-label={aria}
      aria-pressed={m.shape === "cluster" ? undefined : selected}
      aria-haspopup={m.shape === "cluster" ? "listbox" : undefined}
      className="cursor-pointer outline-none"
      onClick={(e) => { e.stopPropagation(); onActivate(); }}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); onActivate(); } }}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      onFocus={() => onFocusChange(true)}
      onBlur={() => onFocusChange(false)}
    >
      {/* Generous invisible hit area, covering the label too. */}
      <rect x={m.x0 - 4} y={m.cy - 13} width={Math.max((m.labelAt === "after" && m.text ? labelX + 4 + m.textW : m.x1) - m.x0 + 8, 24)} height={26} fill="transparent" />
      {ring && (isBar
        ? <rect x={m.x0 - 3} y={m.cy - 13} width={m.x1 - m.x0 + 6} height={26} rx={6} fill="none" stroke={ring} strokeWidth={1.5} />
        : <circle cx={m.cx} cy={m.cy} r={m.shape === "cluster" ? 14 : 12} fill="none" stroke={ring} strokeWidth={1.5} />)}

      <g opacity={dim ? 0.55 : 1}>
        {isBar && !isThread && <BarMark x0={m.x0} x1={m.x1} cy={m.cy} status={it.status} fuzzy={m.shape === "fuzzy"} hatchId={hatchId} />}
        {isThread && <ThreadMark x0={m.x0} x1={m.x1} cy={lineY} dots={m.dots ?? []} />}
        {m.shape === "document" && <DocumentMark cx={m.cx} cy={m.cy} size={hovered || selected ? 15 : 13} />}
        {m.shape === "mail" && <MailDot cx={m.cx} cy={m.cy} r={hovered || selected ? 5 : 4} />}
        {m.shape === "point" && <PointMark cx={m.cx} cy={m.cy} status={it.status} r={hovered || selected ? 7 : 6} />}
        {m.shape === "reminder" && <ReminderMark cx={m.cx} cy={m.cy} overdue={it.overdue} />}
        {m.shape === "source" && <UploadMark cx={m.cx} cy={m.cy} />}
        {m.shape === "cluster" && <ClusterMark cx={m.cx} cy={m.cy} count={m.members.length} />}
      </g>

      {m.text && labelX >= -40 && (
        <text x={labelX} y={labelY} fontSize={isThread ? LABEL_FONT - 0.5 : LABEL_FONT} fontWeight={selected ? 600 : 500}
          fill={m.past && m.labelAt !== "inside" ? "var(--muted)" : "var(--fg)"}>
          {m.text}
        </text>
      )}
    </g>
  );
}

/** "Field trip, 26 November 2026. Not yet confirmed." for screen readers. */
function markAria(it: TimelineItem, t: TFn, w: When): string {
  const parts = [`${it.title}, ${w.when(it.start, it.end, it.precision)}.`, t(it.kind === "event" ? STATUS_LABEL[it.status] : KIND_LABEL[it.kind])];
  if (it.thread && it.thread.messages.length > 1) parts.push(t("timeline.lanesView.messages", { count: it.thread.messages.length }));
  if (it.overdue) parts.push(t("timeline.lanesView.overdueLower"));
  return `${parts[0]} ${parts.slice(1).join(", ")}.`;
}

/** An item's date with its "Due" / "Added" / "Dated" word. */
function datedLine(it: TimelineItem, t: TFn, w: When): string {
  const when = w.when(it.start, it.end, it.precision), k = datePrefixKey(it.kind);
  return k ? t(k, { when }) : when;
}

function Tooltip({ m, width, peopleById }: { m: Placed; width: number; peopleById: Map<string, string> }) {
  const t = useT();
  const w = useWhen();
  const it = m.item;
  const people = it.personIds.map((p) => peopleById.get(p)).filter(Boolean).join(", ");
  const left = Math.min(Math.max(m.cx - 12, 8), Math.max(8, width - 296));
  return (
    <div role="tooltip" className="pointer-events-none absolute z-30 w-max max-w-[288px] rounded-lg bg-surface px-3 py-2.5 text-sm shadow-float"
      style={{ left, top: AXIS_H + m.cy + 18 }}>
      {m.shape === "cluster" ? (
        <>
          <p className="font-medium">{t("timeline.lanesView.clusterTitle", { count: m.members.length })}</p>
          <p className="mt-0.5 text-muted">{t("timeline.lanesView.clusterHint")}</p>
        </>
      ) : (
        <>
          <p className="font-medium leading-snug">{it.title}</p>
          <p className="mt-0.5 text-muted">{datedLine(it, t, w)}</p>
          {it.kind === "thread" && it.summary && <p className="mt-0.5 text-muted">{it.summary}</p>}
          {people && <p className="mt-0.5 text-muted">{people}</p>}
          {(it.kind !== "event" || it.status !== "confirmed" || it.overdue) && (
            <p className={clsx("mt-1 text-xs font-medium", it.overdue ? "text-danger" : it.status === "inferred" ? "text-inferred" : it.kind === "event" ? "text-warn" : "text-muted")}>
              {it.overdue ? t("timeline.status.overdue") : t(it.kind === "event" ? STATUS_LABEL[it.status] : KIND_LABEL[it.kind])}
            </p>
          )}
        </>
      )}
    </div>
  );
}

function ClusterList({ m, width, selectedId, onPick, onClose }: {
  m: Placed; width: number; selectedId: string | null; onPick: (it: TimelineItem) => void; onClose: () => void;
}) {
  const t = useT();
  const w = useWhen();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
    const onDown = (e: PointerEvent) => { if (box.current && !box.current.contains(e.target as Node)) onClose(); };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [onClose]);
  const sorted = [...m.members].sort((a, b) => a.start.localeCompare(b.start));
  const left = Math.min(Math.max(m.cx - 16, 8), Math.max(8, width - 328));
  return (
    <div ref={box} role="listbox" aria-label={t("timeline.lanesView.closeTogether")} style={{ left, top: AXIS_H + m.cy + 18, ...(laneStyle(m.laneId) as CSSProperties) }}
      onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }}
      className="absolute z-40 w-80 rounded-lg bg-surface p-1.5 shadow-float" onPointerDown={(e) => e.stopPropagation()}>
      {sorted.map((it) => (
        <button key={it.id} type="button" role="option" aria-selected={it.id === selectedId} onClick={() => onPick(it)}
          className={clsx("flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left text-sm hover:bg-surface-2 focus-visible:bg-surface-2", it.id === selectedId && "bg-surface-2")}>
          <span className="mt-0.5"><ItemGlyph item={it} personId={m.laneId} size={15} /></span>
          <span className="min-w-0">
            <span className="block font-medium leading-snug">{it.title}</span>
            <span className="block text-muted">{w.when(it.start, it.end, it.precision)}</span>
          </span>
        </button>
      ))}
    </div>
  );
}
