/** Shared SVG glyphs for timeline items — the same look in the swimlanes, the mobile list, the legend and the drawer. */
import type { ItemStatus, TimelineItem } from "@/lib/timeline/types";

export const STATUS_LABEL: Record<ItemStatus, string> = {
  confirmed: "Confirmed",
  unconfirmed: "Not yet confirmed",
  inferred: "Inferred by the assistant",
};

export const KIND_LABEL: Record<TimelineItem["kind"], string> = {
  event: "Event",
  reminder: "Reminder",
  source: "Added to library",
};

/** Fill/stroke for an event mark by status. */
export function statusPaint(status: ItemStatus): { fill: string; stroke: string; dash?: string; strokeWidth: number } {
  switch (status) {
    case "confirmed": return { fill: "var(--t-event)", stroke: "var(--t-event)", strokeWidth: 1.5 };
    case "unconfirmed": return { fill: "var(--surface)", stroke: "var(--t-event)", strokeWidth: 2 };
    case "inferred": return { fill: "var(--surface)", stroke: "var(--inferred)", dash: "2.5 2", strokeWidth: 1.75 };
  }
}

/** Diamond path centred on (cx, cy) with half-diagonal r. */
export const diamond = (cx: number, cy: number, r: number) => `M${cx},${cy - r}L${cx + r},${cy}L${cx},${cy + r}L${cx - r},${cy}Z`;

/** Lucide "bell" outline scaled into a box of `size` px at (x, y) top-left. */
export function BellGlyph({ x, y, size, color }: { x: number; y: number; size: number; color: string }) {
  const s = size / 24;
  return (
    <g transform={`translate(${x},${y}) scale(${s})`} fill="none" stroke={color} strokeWidth={1.6 / s} strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.268 21a2 2 0 0 0 3.464 0" />
      <path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326" fill="var(--surface)" />
    </g>
  );
}

export const reminderColor = (it: Pick<TimelineItem, "overdue">) => (it.overdue ? "var(--danger)" : "var(--warn)");

/** A small standalone glyph (for lists, legend and drawer): 16×16 svg. */
export function ItemGlyph({ item, size = 16 }: { item: Pick<TimelineItem, "kind" | "status" | "end" | "overdue">; size?: number }) {
  const c = size / 2;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true" className="shrink-0">
      {item.kind === "reminder" ? (
        <BellGlyph x={1} y={1} size={size - 2} color={reminderColor(item)} />
      ) : item.kind === "source" ? (
        <rect x={c - 4} y={c - 4} width={8} height={8} rx={1.5} fill="var(--t-document)" />
      ) : item.end ? (
        (() => { const p = statusPaint(item.status); return <rect x={1} y={c - 4} width={size - 2} height={8} rx={4} fill={p.fill} fillOpacity={item.status === "confirmed" ? 0.85 : 1} stroke={p.stroke} strokeWidth={p.strokeWidth} strokeDasharray={p.dash} />; })()
      ) : (
        (() => { const p = statusPaint(item.status); return <path d={diamond(c, c, c - 2)} fill={p.fill} stroke={p.stroke} strokeWidth={p.strokeWidth} strokeDasharray={p.dash} />; })()
      )}
    </svg>
  );
}

/** Legend explaining the marks. */
export function Legend() {
  const entries: { label: string; item: Parameters<typeof ItemGlyph>[0]["item"] }[] = [
    { label: "Confirmed", item: { kind: "event", status: "confirmed", end: null } },
    { label: "Not yet confirmed", item: { kind: "event", status: "unconfirmed", end: null } },
    { label: "Inferred", item: { kind: "event", status: "inferred", end: null } },
    { label: "Lasted a while", item: { kind: "event", status: "confirmed", end: "x" } },
    { label: "Reminder", item: { kind: "reminder", status: "confirmed", end: null } },
    { label: "Added to library", item: { kind: "source", status: "confirmed", end: null } },
  ];
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted" aria-label="What the marks mean">
      {entries.map((e) => (
        <li key={e.label} className="inline-flex items-center gap-1.5"><ItemGlyph item={e.item} size={14} />{e.label}</li>
      ))}
    </ul>
  );
}
