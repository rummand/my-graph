import { line, scaleLinear } from "d3";
import { WELLBEING_VAR, wellbeingBand, WELLBEING_WORDS } from "@/lib/people/circles";
import type { WellbeingPoint } from "@/lib/people/types";

/** Last few wellbeing scores (1–5) as a tiny line; the last point carries the status colour. */
export function Sparkline({ points, width = 84, height = 24 }: { points: WellbeingPoint[]; width?: number; height?: number }) {
  if (points.length === 0) return <span className="text-xs text-muted">—</span>;
  const pad = 4;
  const x = scaleLinear().domain([0, Math.max(points.length - 1, 1)]).range([pad, width - pad]);
  const y = scaleLinear().domain([1, 5]).range([height - pad, pad]);
  const d = line<WellbeingPoint>().x((_, i) => x(i)).y((p) => y(p.score))(points) ?? "";
  const last = points[points.length - 1];
  const words = points.map((p) => WELLBEING_WORDS[p.score]).join(", ");
  return (
    <svg width={width} height={height} role="img" aria-label={`Wellbeing, oldest to newest: ${words}`} className="overflow-visible">
      <title>{`Wellbeing: ${words}`}</title>
      <line x1={pad} x2={width - pad} y1={y(3)} y2={y(3)} stroke="var(--line)" strokeDasharray="2 3" />
      {points.length > 1 && <path d={d} fill="none" stroke="var(--muted)" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />}
      <circle cx={x(points.length - 1)} cy={y(last.score)} r={3.5} fill={WELLBEING_VAR[wellbeingBand(last.score)]} stroke="var(--surface)" strokeWidth={1.5} />
    </svg>
  );
}
