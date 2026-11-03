"use client";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { CIRCLE_VAR, dotRadius, initials, layoutCircles, normaliseCircle, RINGS, WELLBEING_VAR, wellbeingBand, WELLBEING_WORDS } from "@/lib/people/circles";
import type { PersonSummary } from "@/lib/people/types";
import { ago } from "./format";

type Props = { people: PersonSummary[]; center: { id: string; label: string; isViewer: boolean } | null };

function describe(p: PersonSummary): string {
  const latest = p.wellbeing[p.wellbeing.length - 1];
  return [
    p.label,
    p.kindLabel,
    p.relation?.label,
    `last in touch ${ago(p.lastContactAt)}`,
    latest ? `feeling ${WELLBEING_WORDS[latest.score].toLowerCase()}` : "no check-in yet",
  ].filter(Boolean).join(", ");
}

/** Concentric rings of people around the centre person: one ring per circle, dot size = how often you're in touch. */
export function CirclesView({ people, center }: Props) {
  const router = useRouter();
  const [active, setActive] = useState<string | null>(null);
  const centerId = center?.id;
  const others = useMemo(() => people.filter((p) => p.id !== centerId), [people, centerId]);
  // Layout runs a short force simulation: compute once per data change, never on hover.
  const layout = useMemo(() => {
    const maxCount = Math.max(0, ...others.map((p) => p.contactCount90));
    return layoutCircles(
      others.map((p) => ({ id: p.id, circle: p.circle, r: dotRadius(p.contactCount90, maxCount), sortKey: `${p.kind ?? "~"}:${p.label}` })),
      { centerRadius: 34 },
    );
  }, [others]);
  const byId = useMemo(() => new Map(others.map((p) => [p.id, p])), [others]);
  const E = Math.max(layout.extent, 120);
  const activeP = active ? byId.get(active) : null;
  const activePos = active ? layout.placed.find((x) => x.id === active) : null;

  return (
    <div className="relative mx-auto w-full max-w-[760px]">
      <svg viewBox={`${-E} ${-E} ${2 * E} ${2 * E}`} className="h-auto w-full" role="group" aria-label={`People around ${center ? (center.isViewer ? "you" : center.label) : "the family"}, in circles`}>
        {layout.rings.map((r) => (
          <g key={r.key} aria-hidden="true">
            <circle r={r.radius} fill="none" stroke="var(--line)" strokeWidth={1} strokeDasharray="2 4" />
            <text y={-r.radius} dy="-0.4em" textAnchor="middle" fontSize={11} fill="var(--muted)"
              style={{ paintOrder: "stroke", stroke: "var(--surface)", strokeWidth: 4 }}>{r.label}</text>
          </g>
        ))}
        {/* centre */}
        <g aria-hidden="true">
          <circle r={28} fill="var(--accent-tint)" stroke="var(--accent)" strokeWidth={2} />
          <text dy="0.35em" textAnchor="middle" fontSize={13} fontWeight={600} fill="var(--accent)">{center ? (center.isViewer ? "You" : initials(center.label)) : "Us"}</text>
        </g>
        {layout.placed.map((pt) => {
          const p = byId.get(pt.id)!;
          const band = wellbeingBand(p.wellbeing[p.wellbeing.length - 1]?.score);
          const isActive = active === p.id;
          return (
            <a key={p.id} href={`/people/${p.id}`} aria-label={describe(p)}
              onClick={(e) => { e.preventDefault(); router.push(`/people/${p.id}`); }}
              onMouseEnter={() => setActive(p.id)} onMouseLeave={() => setActive((a) => (a === p.id ? null : a))}
              onFocus={() => setActive(p.id)} onBlur={() => setActive((a) => (a === p.id ? null : a))}
              className="cursor-pointer outline-none [&:focus-visible>circle.focus]:stroke-[var(--accent)]">
              <g transform={`translate(${pt.x},${pt.y})`}>
                {/* hit target bigger than the mark */}
                <circle r={pt.r + 6} fill="transparent" />
                <circle className="focus" r={pt.r + 5} fill="none" stroke={isActive ? "var(--fg)" : "transparent"} strokeWidth={1.5} />
                <circle r={pt.r + 1.5} fill="none" stroke={WELLBEING_VAR[band]} strokeWidth={2.5} strokeDasharray={band === "none" ? "2 2" : undefined} />
                <circle r={pt.r - 1.5} fill={CIRCLE_VAR[normaliseCircle(p.circle)]} stroke="var(--surface)" strokeWidth={1.5} />
                <text dy="0.35em" textAnchor="middle" fontSize={Math.max(8, pt.r * 0.72)} fontWeight={600} fill="#fff" pointerEvents="none">{initials(p.label)}</text>
              </g>
            </a>
          );
        })}
      </svg>
      {activeP && activePos && (
        <div role="tooltip" className="pointer-events-none absolute z-10 w-56 -translate-x-1/2 rounded-md border border-line bg-surface p-3 text-sm shadow-lg"
          style={{ left: `${((activePos.x + E) / (2 * E)) * 100}%`, top: `calc(${((activePos.y + activePos.r + E) / (2 * E)) * 100}% + 8px)` }}>
          <div className="font-medium">{activeP.label}</div>
          <div className="text-muted">{[activeP.kindLabel, activeP.relation?.label].filter(Boolean).join(" · ") || "No relation recorded"}</div>
          <div className="mt-1 text-xs text-muted">Last in touch: {ago(activeP.lastContactAt)}</div>
          <div className="text-xs text-muted">
            {activeP.wellbeing.length ? `Feeling: ${WELLBEING_WORDS[activeP.wellbeing[activeP.wellbeing.length - 1].score]}` : "No check-in yet"}
          </div>
        </div>
      )}
      <Legend present={new Set(others.map((p) => normaliseCircle(p.circle)))} />
    </div>
  );
}

function Legend({ present }: { present: Set<string> }) {
  const items = RINGS.flatMap((r) => r.circles).filter((c) => present.has(c));
  const labels: Record<string, string> = { family: "Family", close: "Close friends", school: "School", care: "Care", social: "Friends & neighbours", work: "Work", other: "Others" };
  return (
    <div className="mt-3 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-xs text-muted">
      {items.map((c) => (
        <span key={c} className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: CIRCLE_VAR[c as keyof typeof CIRCLE_VAR] }} />{labels[c]}
        </span>
      ))}
      <span className="inline-flex items-center gap-1.5"><span aria-hidden="true" className="inline-block h-2.5 w-2.5 rounded-full border-2" style={{ borderColor: "var(--wb-good)" }} />Ring: how they are</span>
      <span>Bigger dot: more contact</span>
    </div>
  );
}
