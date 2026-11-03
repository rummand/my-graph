import { CIRCLE_VAR, initials, normaliseCircle, WELLBEING_VAR, wellbeingBand, WELLBEING_WORDS } from "@/lib/people/circles";

/** Small round avatar: initials on the circle colour, with a wellbeing ring. Used in lists and headers. */
export function Avatar({ label, circle, score, size = 36 }: { label: string; circle: string; score?: number | null; size?: number }) {
  const band = wellbeingBand(score);
  const r = size / 2;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true" className="shrink-0">
      <circle cx={r} cy={r} r={r - 2} fill="none" stroke={WELLBEING_VAR[band]} strokeWidth={2.5} strokeDasharray={band === "none" ? "3 3" : undefined} />
      <circle cx={r} cy={r} r={r - 5} fill={CIRCLE_VAR[normaliseCircle(circle)]} />
      <text x={r} y={r} dy="0.35em" textAnchor="middle" fontSize={size * 0.32} fontWeight={600} fill="#fff">{initials(label)}</text>
    </svg>
  );
}

export function WellbeingWord({ score }: { score: number | null | undefined }) {
  if (score == null) return <span className="text-muted">No check-in yet</span>;
  const band = wellbeingBand(score);
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden="true" className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: WELLBEING_VAR[band] }} />
      {WELLBEING_WORDS[score]}
    </span>
  );
}
