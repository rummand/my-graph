"use client";
import type { CSSProperties } from "react";
import { useT } from "@/lib/i18n/client";
import { line, scaleLinear } from "d3";
import { personStyle } from "@/lib/ui/person-color";
import { WELLBEING_VAR, wellbeingBand } from "@/lib/people/circles";
import { wellbeingWord } from "@/lib/people/words";
import type { WellbeingPoint } from "@/lib/people/types";

/** Last few wellbeing scores (1–5) as a tiny line in the person's own colour; the last point carries the status. */
export function Sparkline({ id, points, width = 72, height = 22 }: { id?: string; points: WellbeingPoint[]; width?: number; height?: number }) {
  const t = useT();
  if (points.length === 0) return <span className="inline-block text-muted" style={{ width }}>—</span>;
  const pad = 4;
  const x = scaleLinear().domain([0, Math.max(points.length - 1, 1)]).range([pad, width - pad]);
  const y = scaleLinear().domain([1, 5]).range([height - pad, pad]);
  const d = line<WellbeingPoint>().x((_, i) => x(i)).y((p) => y(p.score))(points) ?? "";
  const last = points[points.length - 1];
  const words = points.map((p) => wellbeingWord(t, p.score)).join(", ");
  return (
    <svg width={width} height={height} role="img" aria-label={t("people.chart.spark", { words })} className="shrink-0 overflow-visible"
      style={(id ? personStyle(id) : { "--person": "var(--muted)" }) as CSSProperties}>
      <title>{t("people.chart.sparkTitle", { words })}</title>
      {points.length > 1 && <path d={d} fill="none" stroke="var(--person)" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />}
      <circle cx={x(points.length - 1)} cy={y(last.score)} r={3} fill={WELLBEING_VAR[wellbeingBand(last.score)]} stroke="var(--surface)" strokeWidth={1.5} />
    </svg>
  );
}
