"use client";
/** A small line chart of one value over time (cobalt, the data hue), with the reference range as a pale band. */
import { useFormatDate } from "@/lib/i18n/client";

export function TrendChart({ points, low, high, min, max, label, unit }: {
  points: { at: string; value: number }[]; low?: number | null; high?: number | null; min?: number; max?: number; label: string; unit?: string | null;
}) {
  const fmt = useFormatDate();
  const W = 320, H = 96, PX = 8, PY = 10;
  const sorted = [...points].sort((a, b) => a.at.localeCompare(b.at));
  if (!sorted.length) return null;
  const vals = sorted.map((p) => p.value);
  const lo = Math.min(min ?? Infinity, ...vals, low ?? Infinity);
  const hi = Math.max(max ?? -Infinity, ...vals, high ?? -Infinity);
  const span = hi - lo || 1;
  const t0 = new Date(sorted[0].at).getTime(), t1 = new Date(sorted[sorted.length - 1].at).getTime();
  const x = (at: string) => (sorted.length === 1 || t1 === t0 ? W / 2 : PX + ((new Date(at).getTime() - t0) / (t1 - t0)) * (W - 2 * PX));
  const y = (v: number) => H - PY - ((v - lo) / span) * (H - 2 * PY);
  const path = sorted.map((p, i) => `${i ? "L" : "M"}${x(p.at).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const last = sorted[sorted.length - 1];
  return (
    <figure className="min-w-0">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-24 w-full" role="img" aria-label={`${label}: ${sorted.map((p) => `${fmt(p.at)} ${p.value}`).join(", ")}`}>
        {low != null && high != null && <rect x={0} width={W} y={y(high)} height={Math.max(1, y(low) - y(high))} className="fill-accent-tint" />}
        <path d={path} fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {sorted.map((p) => <circle key={p.at + p.value} cx={x(p.at)} cy={y(p.value)} r={3} fill="var(--accent)" />)}
      </svg>
      <figcaption className="mt-1 flex justify-between text-xs text-muted tabular-nums">
        <span>{fmt(sorted[0].at)}</span>
        <span className="font-medium text-fg">{last.value}{unit ? ` ${unit}` : ""}</span>
        <span>{fmt(last.at)}</span>
      </figcaption>
    </figure>
  );
}
