/**
 * Pure layout helpers for the timeline screen: the range presets, the opening window, lane packing with labels that
 * never collide, and the one-line summary under the page title. No DOM, no React: covered by layout.test.ts.
 */
import { format } from "date-fns";
import type { TimelineItem } from "@/lib/timeline/types";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/* ── Ranges ─────────────────────────────────────────────────────────────────────────────────────────── */

export type RangeKey = "week" | "month" | "quarter" | "year" | "all";

export const RANGES: { key: RangeKey; label: string }[] = [
  { key: "week", label: "Week" },
  { key: "month", label: "Month" },
  { key: "quarter", label: "3 months" },
  { key: "year", label: "Year" },
  { key: "all", label: "Everything" },
];

/** The window for a range, weighted towards what is coming (a family plans forward). */
export function rangeDomain(key: RangeKey, now: number, extent: [number, number] | null): [number, number] {
  switch (key) {
    case "week": return [now - 2 * DAY, now + 6 * DAY];
    case "month": return [now - 8 * DAY, now + 30 * DAY];
    case "quarter": return [now - 28 * DAY, now + 63 * DAY];
    case "year": return [now - 182 * DAY, now + 183 * DAY];
    case "all": {
      if (!extent) return [now - 182 * DAY, now + 60 * DAY];
      const lo = Math.min(extent[0], now), hi = Math.max(extent[1], now);
      const pad = Math.max((hi - lo) * 0.04, 3 * DAY);
      return [lo - pad, hi + pad];
    }
  }
}

/** Which range a window is showing, if it still matches one (within 2%), so the control can show it as chosen. */
export function matchRange(view: [number, number], now: number, extent: [number, number] | null): RangeKey | null {
  for (const r of RANGES) {
    const [a, b] = rangeDomain(r.key, now, extent);
    const tol = (b - a) * 0.02;
    if (Math.abs(view[0] - a) <= tol && Math.abs(view[1] - b) <= tol) return r.key;
  }
  return null;
}

/** Open on the closest range that has something in it, so the first look is never an empty stretch. */
export function openingRange(items: Pick<TimelineItem, "start" | "end">[], now: number): RangeKey {
  for (const key of ["month", "quarter", "year"] as const) {
    const [a, b] = rangeDomain(key, now, null);
    if (items.some((i) => { const t0 = Date.parse(i.start), t1 = i.end ? Date.parse(i.end) : t0; return t1 >= a && t0 <= b; })) return key;
  }
  return "all";
}

/* ── Labels ─────────────────────────────────────────────────────────────────────────────────────────── */

/** "Emma: Field trip to the Zoo" in Emma's own lane reads as "Field trip to the Zoo". */
export function laneTitle(title: string, laneLabel: string): string {
  const first = laneLabel.trim().split(/\s+/)[0];
  for (const prefix of [laneLabel, first]) {
    if (prefix && title.toLowerCase().startsWith(`${prefix.toLowerCase()}:`)) {
      const rest = title.slice(prefix.length + 1).trim();
      if (rest) return rest;
    }
  }
  return title;
}

/** Cut `text` so that measure(text) fits in `max` px, with an ellipsis. Null when not even a few letters fit. */
export function fitText(text: string, max: number, measure: (s: string) => number, minChars = 4): string | null {
  if (measure(text) <= max) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measure(`${text.slice(0, mid).trimEnd()}…`) <= max) lo = mid; else hi = mid - 1;
  }
  return lo >= minChars ? `${text.slice(0, lo).trimEnd()}…` : null;
}

/* ── Lane packing ───────────────────────────────────────────────────────────────────────────────────── */

export type LaneMark = {
  id: string;
  /** Mark extent in px. Points are their glyph's width around the centre. */
  x0: number;
  x1: number;
  /** Bars carry their label inside when it fits; points always put it after the mark. */
  bar: boolean;
  /** Full label width in px. */
  labelW: number;
};

export type PlacedMark = {
  id: string;
  row: number;
  /** Where the label goes and how much room it has (px). "none": hover or focus shows it. */
  label: { at: "inside" | "after" | "none"; room: number };
};

export type Cluster = { id: string; memberIds: string[]; x0: number; x1: number };

const LABEL_GAP = 6;
const MARK_GAP = 8;

/**
 * Points closer together than `within` px merge into one cluster mark (shown as a count), so a busy day never
 * draws marks on top of each other. Bars never cluster.
 */
export function clusterPoints(marks: LaneMark[], within = 14): { marks: LaneMark[]; clusters: Cluster[] } {
  const bars = marks.filter((m) => m.bar);
  const points = marks.filter((m) => !m.bar).sort((a, b) => a.x0 - b.x0 || cmp(a.id, b.id));
  const out: LaneMark[] = [...bars];
  const clusters: Cluster[] = [];
  let run: LaneMark[] = [];
  const flush = () => {
    if (run.length === 1) out.push(run[0]);
    else if (run.length > 1) {
      const id = `cluster:${run.map((m) => m.id).join("+")}`;
      const x0 = run[0].x0, x1 = run[run.length - 1].x1;
      clusters.push({ id, memberIds: run.map((m) => m.id), x0, x1 });
      out.push({ id, x0, x1: Math.max(x1, x0 + 22), bar: false, labelW: 0 });
    }
    run = [];
  };
  for (const p of points) {
    const prev = run[run.length - 1];
    if (prev && (p.x0 + p.x1) / 2 - (prev.x0 + prev.x1) / 2 > within) flush();
    run.push(p);
  }
  flush();
  return { marks: out, clusters };
}

/**
 * Pack a lane into at most `maxRows` rows so that no two marks and no two labels overlap.
 * Pass 1 reserves each mark's full label; if that would need more rows, pass 2 packs bare marks and gives each label
 * the room left before the next mark in its row (the caller cuts the text to fit, or hides it).
 */
export function packMarks(marks: LaneMark[], maxRows = 2): { placed: Map<string, PlacedMark>; rows: number } {
  const sorted = [...marks].sort((a, b) => a.x0 - b.x0 || cmp(a.id, b.id));
  const full = (m: LaneMark) => (m.bar && m.labelW + 16 <= m.x1 - m.x0 ? m.x1 : m.x1 + (m.labelW ? LABEL_GAP + m.labelW : 0));

  const tryPack = (end: (m: LaneMark) => number) => {
    const ends: number[] = [];
    const rowOf = new Map<string, number>();
    for (const m of sorted) {
      let row = ends.findIndex((e) => e + MARK_GAP <= m.x0);
      if (row === -1) {
        if (ends.length >= maxRows) return null;
        row = ends.length;
        ends.push(-Infinity);
      }
      ends[row] = Math.max(ends[row], end(m));
      rowOf.set(m.id, row);
    }
    return { rowOf, rows: Math.max(1, ends.length) };
  };

  const roomy = tryPack(full);
  const placed = new Map<string, PlacedMark>();
  if (roomy) {
    for (const m of sorted) {
      const inside = m.bar && m.labelW + 16 <= m.x1 - m.x0;
      placed.set(m.id, { id: m.id, row: roomy.rowOf.get(m.id)!, label: m.labelW ? { at: inside ? "inside" : "after", room: m.labelW } : { at: "none", room: 0 } });
    }
    return { placed, rows: roomy.rows };
  }

  // Bare marks: put each in the row that frees up soonest (overlap only if the lane is truly saturated).
  const ends: number[] = [];
  const rowOf = new Map<string, number>();
  for (const m of sorted) {
    let row = ends.findIndex((e) => e + MARK_GAP <= m.x0);
    if (row === -1) row = ends.length < maxRows ? ends.push(-Infinity) - 1 : ends.indexOf(Math.min(...ends));
    ends[row] = Math.max(ends[row], m.x1);
    rowOf.set(m.id, row);
  }
  const byRow = new Map<number, LaneMark[]>();
  for (const m of sorted) {
    const r = rowOf.get(m.id)!;
    (byRow.get(r) ?? byRow.set(r, []).get(r)!).push(m);
  }
  for (const [row, list] of byRow) {
    for (let i = 0; i < list.length; i++) {
      const m = list[i], next = list[i + 1];
      if (!m.labelW) { placed.set(m.id, { id: m.id, row, label: { at: "none", room: 0 } }); continue; }
      const innerRoom = m.bar ? m.x1 - m.x0 - 16 : 0;
      const afterRoom = (next ? next.x0 - MARK_GAP : Infinity) - (m.x1 + LABEL_GAP);
      const label = innerRoom >= m.labelW ? { at: "inside" as const, room: innerRoom }
        : afterRoom >= Math.min(m.labelW, 40) ? { at: "after" as const, room: Math.min(afterRoom, m.labelW) }
          : innerRoom >= 40 ? { at: "inside" as const, room: innerRoom }
            : { at: "none" as const, room: 0 };
      placed.set(m.id, { id: m.id, row, label });
    }
  }
  return { placed, rows: Math.max(1, ends.length) };
}

function cmp(a: string, b: string) { return a < b ? -1 : a > b ? 1 : 0; }

/* ── Summary line ───────────────────────────────────────────────────────────────────────────────────── */

/** One sentence about what's coming, for under the page title. */
export function upcomingSummary(items: Pick<TimelineItem, "kind" | "title" | "start">[], now: number): string {
  const ahead = items.filter((i) => i.kind !== "source" && Date.parse(i.start) >= now).sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  if (!ahead.length) return items.length ? "Nothing coming up yet. Everything here has already happened." : "What happened and what's coming, one lane for each person.";
  const soon = ahead.filter((i) => Date.parse(i.start) <= now + 30 * DAY).length;
  // Name the next event rather than a reminder about it, when one is coming within the month.
  const next = ahead.find((i) => i.kind === "event" && Date.parse(i.start) <= now + 30 * DAY) ?? ahead[0];
  const when = format(new Date(next.start), "EEE d MMM");
  const lead = soon > 1 ? `${soon} things in the next 30 days.` : soon === 1 ? "One thing in the next 30 days." : "Nothing in the next 30 days.";
  return `${lead} Next up: ${next.title} on ${when}.`;
}
