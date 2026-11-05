/**
 * The small charts beside a pattern. Cobalt is the one data hue (DESIGN.md): the part of the chart that IS the
 * pattern is full cobalt, the rest is cobalt at low opacity. No axes, no gridlines; every chart has a text label.
 */
import type { Chart } from "@/lib/you/types";

const W = 132, H = 44;

function scale(values: readonly (number | null)[]) {
  const nums = values.filter((v): v is number => v !== null);
  const min = Math.min(0, ...nums), max = Math.max(...nums, min + 1e-6);
  return { min, max, y: (v: number) => H - 2 - ((v - min) / (max - min)) * (H - 4) };
}

export function Spark({ values, highlight = [], label }: { values: readonly (number | null)[]; highlight?: number[]; label: string }) {
  const n = Math.max(1, values.length);
  const bw = W / n;
  const s = scale(values);
  const zero = s.y(0);
  const hi = new Set(highlight);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label={label} className="text-accent">
      <title>{label}</title>
      <line x1={0} x2={W} y1={zero + 0.5} y2={zero + 0.5} className="stroke-line" strokeWidth={1} />
      {values.map((v, i) => {
        if (v === null || v === 0) return null;
        const y = s.y(v);
        const top = Math.min(y, zero), h = Math.max(1.5, Math.abs(zero - y));
        return <rect key={i} x={i * bw + bw * 0.15} y={top} width={Math.max(1, bw * 0.7)} height={h} rx={0.75} fill="currentColor" opacity={hi.size === 0 || hi.has(i) ? 0.9 : 0.3} />;
      })}
    </svg>
  );
}

/** Twelve months round a ring (January at the top, clockwise); the pattern's months in full cobalt. */
export function Ring({ months, highlight, label }: { months: readonly (number | null)[]; highlight: number[]; label: string }) {
  const size = 64, c = size / 2, inner = 11, outer = c - 2;
  const nums = months.filter((v): v is number => v !== null);
  const max = Math.max(...nums, 1e-6), min = Math.min(...nums, 0);
  const hi = new Set(highlight);
  const arc = (i: number, r: number) => {
    const a0 = ((i - 0.42) / 12) * Math.PI * 2 - Math.PI / 2, a1 = ((i + 0.42) / 12) * Math.PI * 2 - Math.PI / 2;
    // Rounded, so the server and the browser write the same path (no hydration mismatch).
    const p = (a: number, rr: number) => `${(c + rr * Math.cos(a)).toFixed(2)} ${(c + rr * Math.sin(a)).toFixed(2)}`;
    return `M ${p(a0, inner)} L ${p(a0, r)} A ${r.toFixed(2)} ${r.toFixed(2)} 0 0 1 ${p(a1, r)} L ${p(a1, inner)} A ${inner} ${inner} 0 0 0 ${p(a0, inner)} Z`;
  };
  return (
    <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} role="img" aria-label={label} className="text-accent">
      <title>{label}</title>
      <circle cx={c} cy={c} r={outer} className="fill-surface-2" />
      {months.map((v, i) => {
        if (v === null) return null;
        const r = inner + 2 + ((v - min) / (max - min || 1)) * (outer - inner - 2);
        return <path key={i} d={arc(i, r)} fill="currentColor" opacity={hi.has(i) ? 0.95 : 0.3} />;
      })}
    </svg>
  );
}

/** Two signals over the same weeks: the first as soft bars, the second as a line. */
export function Pair({ a, b, label }: { a: readonly (number | null)[]; b: readonly (number | null)[]; label: string }) {
  const n = Math.max(a.length, b.length, 1);
  const bw = W / n;
  const sa = scale(a), sb = scale(b);
  let d = "";
  b.forEach((v, i) => { if (v === null) return; d += `${d ? "L" : "M"} ${((i + 0.5) * bw).toFixed(2)} ${sb.y(v).toFixed(2)} `; });
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label={label} className="text-accent">
      <title>{label}</title>
      {a.map((v, i) => (v === null || v === 0 ? null : <rect key={i} x={i * bw + bw * 0.15} y={sa.y(v)} width={Math.max(1, bw * 0.7)} height={Math.max(1, H - 2 - sa.y(v))} fill="currentColor" opacity={0.25} />))}
      <path d={d} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export function Bars({ a, b, labels, label }: { a: number; b: number; labels: [string, string]; label: string }) {
  const max = Math.max(a, b, 1e-6);
  return (
    <div role="img" aria-label={label} className="w-[132px] space-y-1.5 text-accent">
      {[a, b].map((v, i) => (
        <div key={i}>
          <div className="h-2.5 rounded-sm bg-current" style={{ width: `${Math.max(4, (v / max) * 100)}%`, opacity: i === 0 ? 0.9 : 0.3 }} />
          <div className="mt-0.5 text-[11px] leading-tight text-muted">{labels[i]}</div>
        </div>
      ))}
    </div>
  );
}

export function InsightChart({ chart, labels }: { chart: Chart; labels: { ring: string; pair: string; bars: string; spark: string; barA: string; barB: string } }) {
  switch (chart.type) {
    case "ring": return <Ring months={chart.months} highlight={chart.highlight} label={labels.ring} />;
    case "pair": return <Pair a={chart.a} b={chart.b} label={labels.pair} />;
    case "bars": return <Bars a={chart.a} b={chart.b} labels={[labels.barA, labels.barB]} label={labels.bars} />;
    case "spark": return <Spark values={chart.values} highlight={chart.highlight} label={labels.spark} />;
  }
}
