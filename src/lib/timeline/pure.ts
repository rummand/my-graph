/**
 * Pure timeline logic (no DB, no DOM): lane ordering, row packing, tick choice, date formatting and grouping.
 * Safe to import from client components.
 */
import { format } from "date-fns";
import type { ItemStatus, Lane, TimePrecision, TimelineItem } from "./types";
import { FAMILY_LANE } from "./types";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/* ── Lanes ───────────────────────────────────────────────────────────────────────────────────────────── */

export type LaneCandidate = {
  id: string;
  label: string;
  isViewer: boolean;
  /** A child account in the household. */
  isChild: boolean;
  /** Has a login in the household (parents, children, the viewer). */
  isMember: boolean;
  birthYear: number | null;
  /** Events in the current result involving this person. */
  eventCount: number;
};

const byLabel = (a: { label: string }, b: { label: string }) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" });

/**
 * Lane order: the viewer, then children by birth year (oldest first; unknown years last), then other household
 * members by name, then everyone else (most events first, then name). Duplicates are dropped.
 */
export function orderLanes(people: LaneCandidate[]): Lane[] {
  const seen = new Set<string>();
  const unique = people.filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true)));
  const viewer = unique.filter((p) => p.isViewer);
  const children = unique.filter((p) => !p.isViewer && p.isChild)
    .sort((a, b) => (a.birthYear ?? Infinity) - (b.birthYear ?? Infinity) || byLabel(a, b));
  const members = unique.filter((p) => !p.isViewer && !p.isChild && p.isMember).sort(byLabel);
  const others = unique.filter((p) => !p.isViewer && !p.isChild && !p.isMember)
    .sort((a, b) => b.eventCount - a.eventCount || byLabel(a, b));
  return [
    ...viewer.map((p) => lane(p, "viewer")),
    ...children.map((p) => lane(p, "child")),
    ...members.map((p) => lane(p, "member")),
    ...others.map((p) => lane(p, "person")),
  ];
}

function lane(p: LaneCandidate, kind: Lane["kind"]): Lane {
  return { id: p.id, label: p.label, kind, birthYear: p.birthYear };
}

export const familyLane = (label = "Family"): Lane => ({ id: FAMILY_LANE, label, kind: "family", birthYear: null });

/** The lanes an item belongs in: each involved person that has a lane, else the Family lane. */
export function laneIdsFor(personIds: string[], laneIds: ReadonlySet<string>): string[] {
  const hit = [...new Set(personIds)].filter((id) => laneIds.has(id));
  return hit.length ? hit : [FAMILY_LANE];
}

/* ── Status ──────────────────────────────────────────────────────────────────────────────────────────── */

export type ProvLite = { activity: string; agentType: string };

/**
 * How sure we are an event happened:
 *  - an explicit `props.status` wins;
 *  - anyone recording it by hand (user agent) makes it confirmed;
 *  - only inference behind it → inferred (never silently promoted);
 *  - otherwise (read from a document by a model, or no provenance yet) → unconfirmed.
 */
export function deriveStatus(props: Record<string, unknown> | null | undefined, provs: ProvLite[]): ItemStatus {
  const explicit = props?.status;
  if (explicit === "confirmed" || explicit === "unconfirmed" || explicit === "inferred") return explicit;
  if (provs.some((p) => p.agentType === "user")) return "confirmed";
  if (provs.length > 0 && provs.every((p) => p.activity === "inference")) return "inferred";
  return "unconfirmed";
}

/* ── Row packing ─────────────────────────────────────────────────────────────────────────────────────── */

export type PackInput = {
  id: string;
  /** Left edge in px. */
  x0: number;
  /** Right edge in px including the label. */
  x1Label: number;
  /** Right edge in px of the mark alone. */
  x1Bare: number;
};

export type PackResult = {
  placed: Map<string, { row: number; label: boolean }>;
  rowCount: number;
  /** Items that had to overlap another because every row was taken. */
  forced: number;
};

/**
 * Greedy interval packing into at most `maxRows` rows: items in start order, each into the first row that is free at
 * its start; when every row is busy, into the row that frees up soonest (counted in `forced`). `width` picks which
 * right edge reserves space. Deterministic: ties broken by id.
 */
export function packRows(items: PackInput[], opts: { gap?: number; maxRows?: number; width?: "label" | "bare" } = {}): PackResult {
  const gap = opts.gap ?? 4;
  const maxRows = Math.max(1, opts.maxRows ?? 4);
  const useLabel = (opts.width ?? "label") === "label";
  const sorted = [...items].sort((a, b) => a.x0 - b.x0 || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const ends: number[] = [];
  const placed = new Map<string, { row: number; label: boolean }>();
  let forced = 0;

  for (const it of sorted) {
    let row = -1;
    for (let r = 0; r < maxRows; r++) if (r >= ends.length || ends[r] + gap <= it.x0) { row = r; break; }
    if (row === -1) {
      forced++;
      row = ends.reduce((best, e, r) => (e < ends[best] ? r : best), 0);
    }
    const end = useLabel ? Math.max(it.x1Label, it.x1Bare) : it.x1Bare;
    ends[row] = Math.max(ends[row] ?? -Infinity, end);
    placed.set(it.id, { row, label: useLabel });
  }
  return { placed, rowCount: Math.max(1, ends.length), forced };
}

/**
 * Lane layout. First try reserving room for every label; if that forces overlaps, pack the bare marks instead and
 * show a label only where it fits before the next mark in its row (the rest appear on hover/focus).
 */
export function packLane(items: PackInput[], opts: { gap?: number; maxRows?: number } = {}): PackResult {
  const gap = opts.gap ?? 4;
  const withLabels = packRows(items, { ...opts, width: "label" });
  if (withLabels.forced === 0) return withLabels;
  const bare = packRows(items, { ...opts, width: "bare" });
  const rows = new Map<number, PackInput[]>();
  for (const it of items) {
    const r = bare.placed.get(it.id)!.row;
    (rows.get(r) ?? rows.set(r, []).get(r)!).push(it);
  }
  for (const row of rows.values()) {
    row.sort((a, b) => a.x0 - b.x0 || (a.id < b.id ? -1 : 1));
    let prevEnd = -Infinity;
    for (let i = 0; i < row.length; i++) {
      const it = row[i];
      const next = row[i + 1];
      const free = it.x0 >= prevEnd + gap && (!next || Math.max(it.x1Label, it.x1Bare) + gap <= next.x0);
      bare.placed.get(it.id)!.label = free;
      prevEnd = Math.max(prevEnd, free ? Math.max(it.x1Label, it.x1Bare) : it.x1Bare);
    }
  }
  return bare;
}

/* ── Ticks ───────────────────────────────────────────────────────────────────────────────────────────── */

export type TickUnit = "hour" | "day" | "week" | "month" | "year";
export type TickSpec = { unit: TickUnit; step: number };

const UNIT_MS: Record<TickUnit, number> = { hour: HOUR, day: DAY, week: 7 * DAY, month: 30.44 * DAY, year: 365.25 * DAY };

/** Candidate tick steps, finest first. */
export const TICK_SPECS: TickSpec[] = [
  { unit: "hour", step: 1 }, { unit: "hour", step: 3 }, { unit: "hour", step: 6 }, { unit: "hour", step: 12 },
  { unit: "day", step: 1 }, { unit: "day", step: 2 },
  { unit: "week", step: 1 },
  { unit: "month", step: 1 }, { unit: "month", step: 3 }, { unit: "month", step: 6 },
  { unit: "year", step: 1 }, { unit: "year", step: 2 }, { unit: "year", step: 5 }, { unit: "year", step: 10 },
  { unit: "year", step: 25 }, { unit: "year", step: 50 }, { unit: "year", step: 100 },
];

/** The finest tick step whose spacing is at least `minSpacing` px when `spanMs` fills `widthPx`. */
export function chooseTickSpec(spanMs: number, widthPx: number, minSpacing = 72): TickSpec {
  if (!(spanMs > 0) || !(widthPx > 0)) return { unit: "year", step: 1 };
  const pxPerMs = widthPx / spanMs;
  for (const s of TICK_SPECS) if (UNIT_MS[s.unit] * s.step * pxPerMs >= minSpacing) return s;
  return TICK_SPECS[TICK_SPECS.length - 1];
}

/** Axis label for a tick (local time). The first tick of a bigger unit carries that unit (Jan → year). */
export function tickLabel(d: Date, spec: TickSpec): string {
  switch (spec.unit) {
    case "year": return format(d, "yyyy");
    case "month": return d.getMonth() === 0 ? format(d, "yyyy") : format(d, "MMM");
    case "week": return format(d, "d MMM");
    case "day": return d.getDate() === 1 ? format(d, "d MMM") : format(d, spec.step === 1 ? "EEE d" : "d");
    case "hour": return d.getHours() === 0 ? format(d, "EEE d MMM") : format(d, "HH:mm");
  }
}

/** True for ticks that start a bigger unit (drawn a little stronger). */
export function isMajorTick(d: Date, spec: TickSpec): boolean {
  switch (spec.unit) {
    case "year": return d.getFullYear() % (spec.step * 10) === 0;
    case "month": return d.getMonth() === 0;
    case "week": return d.getDate() <= 7;
    case "day": return d.getDate() === 1;
    case "hour": return d.getHours() === 0;
  }
}

/** The left-edge context shown beside the axis ("March 2021" when ticks are days). Empty for years. */
export function axisContext(d: Date, spec: TickSpec): string {
  if (spec.unit === "year") return "";
  if (spec.unit === "month") return format(d, "yyyy");
  return format(d, "MMMM yyyy");
}

/* ── Dates ───────────────────────────────────────────────────────────────────────────────────────────── */

const toDate = (d: Date | string) => (d instanceof Date ? d : new Date(d));

/**
 * The calendar day of a day/month/year-precision instant as a local Date. Ingest stores such dates either at UTC
 * midnight or at a local time on that day (e.g. 00:00 or 07:00 Copenhagen); shifting by 12 h before reading the UTC
 * date maps all of those to the intended day.
 */
export function calendarDay(d: Date | string): Date {
  const s = new Date(toDate(d).getTime() + 12 * HOUR);
  return new Date(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate());
}

/** Precision to use when none was recorded: UTC midnight reads as a day, anything else as a moment. */
export function effectivePrecision(start: Date | string, precision: TimePrecision | null): TimePrecision {
  if (precision) return precision;
  const d = toDate(start);
  return d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 ? "day" : "minute";
}

/** "2021", "March 2021", "3 March 2021", "3 March 2021, 14:30" — and ranges, collapsing what both ends share. */
export function formatWhen(start: Date | string, end: Date | string | null, precision: TimePrecision | null): string {
  const p = effectivePrecision(start, precision);
  const a = p === "minute" ? toDate(start) : calendarDay(start);
  const b = end ? (p === "minute" ? toDate(end) : calendarDay(end)) : null;
  const one = (d: Date) => format(d, p === "year" ? "yyyy" : p === "month" ? "MMMM yyyy" : p === "day" ? "d MMMM yyyy" : "d MMMM yyyy, HH:mm");
  if (!b || b.getTime() <= a.getTime() || one(a) === one(b)) return one(a);

  const sameYear = a.getFullYear() === b.getFullYear();
  const sameMonth = sameYear && a.getMonth() === b.getMonth();
  const sameDay = sameMonth && a.getDate() === b.getDate();
  switch (p) {
    case "year": return `${format(a, "yyyy")} – ${format(b, "yyyy")}`;
    case "month": return sameYear ? `${format(a, "MMMM")} – ${format(b, "MMMM yyyy")}` : `${format(a, "MMMM yyyy")} – ${format(b, "MMMM yyyy")}`;
    case "day":
      if (sameMonth) return `${format(a, "d")} – ${format(b, "d MMMM yyyy")}`;
      if (sameYear) return `${format(a, "d MMMM")} – ${format(b, "d MMMM yyyy")}`;
      return `${format(a, "d MMMM yyyy")} – ${format(b, "d MMMM yyyy")}`;
    case "minute":
      if (sameDay) return `${format(a, "d MMMM yyyy, HH:mm")} – ${format(b, "HH:mm")}`;
      return `${format(a, "d MMMM yyyy, HH:mm")} – ${format(b, "d MMMM yyyy, HH:mm")}`;
  }
}

/** Where an item is drawn: [start, end] in ms. Fuzzy (month/year) points cover their whole month/year. */
export function itemExtent(it: Pick<TimelineItem, "start" | "end" | "precision">): { t0: number; t1: number; fuzzy: boolean } {
  const t0 = toDate(it.start).getTime();
  if (it.end) {
    const t1 = toDate(it.end).getTime();
    return { t0, t1: Math.max(t0, t1), fuzzy: false };
  }
  if (it.precision === "month" || it.precision === "year") {
    const c = calendarDay(it.start);
    const s = it.precision === "month" ? new Date(c.getFullYear(), c.getMonth(), 1) : new Date(c.getFullYear(), 0, 1);
    const e = it.precision === "month" ? new Date(c.getFullYear(), c.getMonth() + 1, 1) : new Date(c.getFullYear() + 1, 0, 1);
    return { t0: s.getTime(), t1: e.getTime(), fuzzy: true };
  }
  return { t0, t1: t0, fuzzy: false };
}

/* ── Grouping & ranges ───────────────────────────────────────────────────────────────────────────────── */

export type MonthGroup<T> = { key: string; label: string; items: T[] };

/** Items grouped by calendar month (in start order), e.g. { key: "2021-03", label: "March 2021" }. */
export function groupByMonth<T extends Pick<TimelineItem, "start" | "precision">>(items: T[]): MonthGroup<T>[] {
  const sorted = [...items].sort((a, b) => toDate(a.start).getTime() - toDate(b.start).getTime());
  const groups: MonthGroup<T>[] = [];
  for (const it of sorted) {
    const d = effectivePrecision(it.start, it.precision) === "minute" ? toDate(it.start) : calendarDay(it.start);
    const key = format(d, "yyyy-MM");
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(it);
    else groups.push({ key, label: format(d, "MMMM yyyy"), items: [it] });
  }
  return groups;
}

export type Preset = "week" | "month" | "year" | "all";

/** The visible window for a preset, around `now`. "all" covers the data with a little padding. */
export function presetDomain(preset: Preset, now: Date, extent: [number, number] | null): [Date, Date] {
  const t = now.getTime();
  switch (preset) {
    case "week": return [new Date(t - 3 * DAY), new Date(t + 4 * DAY)];
    case "month": return [new Date(t - 20 * DAY), new Date(t + 10 * DAY)];
    case "year": return [new Date(t - 270 * DAY), new Date(t + 95 * DAY)];
    case "all": {
      if (!extent) return [new Date(t - 365 * DAY), new Date(t + 60 * DAY)];
      const lo = Math.min(extent[0], t), hi = Math.max(extent[1], t);
      const pad = Math.max((hi - lo) * 0.04, 3 * DAY);
      return [new Date(lo - pad), new Date(hi + pad)];
    }
  }
}

/** [min start, max end] over items in ms, or null when empty. */
export function dataExtent(items: Pick<TimelineItem, "start" | "end" | "precision">[]): [number, number] | null {
  if (!items.length) return null;
  let lo = Infinity, hi = -Infinity;
  for (const it of items) {
    const { t0, t1 } = itemExtent(it);
    if (t0 < lo) lo = t0;
    if (t1 > hi) hi = t1;
  }
  return [lo, hi];
}

/** Case- and accent-insensitive match on title and summary; best (title prefix) matches first. */
export function searchItems<T extends Pick<TimelineItem, "title" | "summary">>(items: T[], query: string, limit = 8): T[] {
  const norm = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
  const q = norm(query.trim());
  if (!q) return [];
  const scored: { it: T; s: number }[] = [];
  for (const it of items) {
    const t = norm(it.title);
    const s = t.startsWith(q) ? 0 : t.includes(q) ? 1 : it.summary && norm(it.summary).includes(q) ? 2 : -1;
    if (s >= 0) scored.push({ it, s });
  }
  return scored.sort((a, b) => a.s - b.s).slice(0, limit).map((x) => x.it);
}

/** Initials for a lane avatar: "Ida Marie Hansen" → "IH". */
export function initials(label: string): string {
  const parts = label.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  const first = parts[0][0] ?? "";
  const last = parts.length > 1 ? parts[parts.length - 1][0] ?? "" : "";
  return (first + last).toUpperCase();
}
