/**
 * The timeline's marks. Each kind of thing has its own shape, drawn in the colour of the person whose lane it sits in
 * (the parent sets --person and --person-tint via personStyle). The legend draws the same shapes, scaled down, and
 * lists only the kinds on screen.
 */
import type { CSSProperties } from "react";
import { personStyle } from "@/lib/ui/person-color";
import type { ItemStatus, TimelineItem } from "@/lib/timeline/types";

export const STATUS_LABEL: Record<ItemStatus, string> = {
  confirmed: "Confirmed",
  unconfirmed: "Not yet confirmed",
  inferred: "Inferred by the assistant",
};

export const KIND_LABEL: Record<TimelineItem["kind"], string> = {
  event: "Event",
  reminder: "Reminder",
  source: "Added to the library",
};

/** Every mark the screen can draw. */
export type MarkKind = "confirmed" | "unconfirmed" | "inferred" | "span" | "fuzzy" | "reminder" | "overdue" | "upload";

export const MARK_LABEL: Record<MarkKind, string> = {
  confirmed: "Confirmed",
  unconfirmed: "Not yet confirmed",
  inferred: "Inferred",
  span: "Lasts a while",
  fuzzy: "Month or year only",
  reminder: "Reminder",
  overdue: "Overdue reminder",
  upload: "Upload",
};

export const MARK_ORDER: MarkKind[] = ["confirmed", "unconfirmed", "inferred", "span", "fuzzy", "reminder", "overdue", "upload"];

/** Lane colours for a person, or quiet ink for the Family lane. */
export function laneStyle(laneId: string | null): CSSProperties {
  if (!laneId || laneId === "family") return { "--person": "var(--muted)", "--person-tint": "var(--surface-2)" } as CSSProperties;
  return personStyle(laneId) as CSSProperties;
}

export const diamond = (cx: number, cy: number, r: number) => `M${cx},${cy - r}L${cx + r},${cy}L${cx},${cy + r}L${cx - r},${cy}Z`;

/** A point in time. Confirmed is solid; not yet confirmed is a dashed outline; inferred is a dotted plum outline. */
export function PointMark({ cx, cy, status, r = 6 }: { cx: number; cy: number; status: ItemStatus; r?: number }) {
  const d = diamond(cx, cy, r);
  if (status === "confirmed") return <path d={d} fill="var(--person)" />;
    // Dashed so each side breaks in its middle and the corners stay whole: reads as a diamond, not a dotted ring.
  const side = r * Math.SQRT2;
  if (status === "unconfirmed") return <path d={d} fill="var(--surface)" stroke="var(--person)" strokeWidth={1.6} strokeLinejoin="round" strokeDasharray={`${side * 0.7} ${side * 0.3}`} strokeDashoffset={side * 0.35} />;
  return <path d={d} fill="var(--inferred-tint)" stroke="var(--inferred)" strokeWidth={1.5} strokeDasharray="0.1 2.6" strokeLinecap="round" />;
}

/** Hatch for inferred bars. Put once in each <svg>'s <defs>. */
export function HatchDef({ id }: { id: string }) {
  return (
    <pattern id={id} width={5} height={5} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <rect width={5} height={5} fill="var(--inferred-tint)" />
      <line x1={0} y1={0} x2={0} y2={5} stroke="var(--inferred)" strokeWidth={1} strokeOpacity={0.55} />
    </pattern>
  );
}

/** A span of time: pale fill in the person's tint with a 3px edge in their colour; dashed when not confirmed. */
export function BarMark({ x0, x1, cy, status, fuzzy, h = 20, hatchId }: { x0: number; x1: number; cy: number; status: ItemStatus; fuzzy?: boolean; h?: number; hatchId: string }) {
  const w = Math.max(4, x1 - x0), y = cy - h / 2;
  if (fuzzy) {
    return <rect x={x0} y={y} width={w} height={h} rx={4} fill="var(--person-tint)" fillOpacity={0.6} stroke="var(--person)" strokeOpacity={0.35} strokeDasharray="1 3" />;
  }
  if (status === "inferred") return <rect x={x0 + 0.5} y={y + 0.5} width={w - 1} height={h - 1} rx={4} fill={`url(#${hatchId})`} stroke="var(--inferred)" strokeOpacity={0.7} />;
  if (status === "unconfirmed") return <rect x={x0 + 0.75} y={y + 0.75} width={w - 1.5} height={h - 1.5} rx={4} fill="var(--person-tint)" stroke="var(--person)" strokeWidth={1.5} strokeDasharray="4 2.5" />;
  return (
    <g>
      <rect x={x0} y={y} width={w} height={h} rx={4} fill="var(--person-tint)" />
      <rect x={x0} y={y} width={Math.min(3, w)} height={h} rx={1.5} fill="var(--person)" />
    </g>
  );
}

/** Lucide "bell", scaled into a `size` box centred on (cx, cy). Amber: it needs doing; brick: it's late. */
export function ReminderMark({ cx, cy, overdue, size = 15 }: { cx: number; cy: number; overdue?: boolean; size?: number }) {
  const s = size / 24;
  return (
    <g transform={`translate(${cx - size / 2},${cy - size / 2}) scale(${s})`} fill="none" stroke={overdue ? "var(--danger)" : "var(--warn)"} strokeWidth={1.8 / s} strokeLinecap="round" strokeLinejoin="round">
      <path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326" fill={overdue ? "var(--danger-tint)" : "var(--warn-tint)"} />
      <path d="M10.268 21a2 2 0 0 0 3.464 0" />
    </g>
  );
}

/** A file added to the library. */
export function UploadMark({ cx, cy, size = 9 }: { cx: number; cy: number; size?: number }) {
  return <rect x={cx - size / 2} y={cy - size / 2} width={size} height={size} rx={2} fill="var(--muted)" />;
}

/** Several things on (nearly) the same day: a disc in the person's colour with the count. */
export function ClusterMark({ cx, cy, count }: { cx: number; cy: number; count: number }) {
  return (
    <g>
      <circle cx={cx} cy={cy} r={10} fill="var(--person)" />
      <text x={cx} y={cy + 4} textAnchor="middle" fontSize={11} fontWeight={600} fill="var(--surface)" style={{ fontVariantNumeric: "tabular-nums" }}>{count}</text>
    </g>
  );
}

/** Which mark an item gets when drawn as a point (lists, drawer, search). */
export function markKindOf(item: Pick<TimelineItem, "kind" | "status" | "end" | "overdue" | "precision">): MarkKind {
  if (item.kind === "reminder") return item.overdue ? "overdue" : "reminder";
  if (item.kind === "source") return "upload";
  if (item.end) return item.status === "confirmed" ? "span" : item.status;
  if (item.precision === "month" || item.precision === "year") return "fuzzy";
  return item.status;
}

/** One mark as a small standalone svg. */
export function MarkSwatch({ kind, size = 16 }: { kind: MarkKind; size?: number }) {
  const c = size / 2;
  return (
    <svg width={kind === "span" || kind === "fuzzy" ? size * 1.5 : size} height={size} aria-hidden="true" className="shrink-0 overflow-visible">
      {kind === "confirmed" || kind === "unconfirmed" || kind === "inferred" ? <PointMark cx={c} cy={c} r={c - 2} status={kind} />
        : kind === "span" ? <BarMark x0={0.5} x1={size * 1.5 - 0.5} cy={c} h={size - 4} status="confirmed" hatchId="" />
          : kind === "fuzzy" ? <BarMark x0={0.5} x1={size * 1.5 - 0.5} cy={c} h={size - 4} status="confirmed" fuzzy hatchId="" />
            : kind === "reminder" || kind === "overdue" ? <ReminderMark cx={c} cy={c} size={size - 1} overdue={kind === "overdue"} />
              : <UploadMark cx={c} cy={c} size={size * 0.56} />}
    </svg>
  );
}

/** The item's own glyph, in the colour of the first person it involves. */
export function ItemGlyph({ item, personId, size = 16 }: { item: Pick<TimelineItem, "kind" | "status" | "end" | "overdue" | "precision">; personId?: string | null; size?: number }) {
  return <span style={laneStyle(personId ?? null)} className="inline-flex"><MarkSwatch kind={markKindOf(item)} size={size} /></span>;
}

/** Legend: each swatch is the mark itself, in neutral ink, listing only the kinds on screen. */
export function Legend({ kinds }: { kinds: Set<MarkKind> }) {
  const shown = MARK_ORDER.filter((k) => kinds.has(k));
  if (!shown.length) return null;
  return (
    <ul className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-muted" aria-label="What the marks mean"
      style={{ "--person": "var(--fg)", "--person-tint": "var(--surface-2)" } as CSSProperties}>
      {shown.map((k) => (
        <li key={k} className="inline-flex items-center gap-2"><MarkSwatch kind={k} size={14} />{MARK_LABEL[k]}</li>
      ))}
    </ul>
  );
}
