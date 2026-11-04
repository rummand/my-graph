"use client";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Avatar } from "@/components/ui";
import { layoutCircles, WELLBEING_WORDS } from "@/lib/people/circles";
import type { CenterOption, PersonSummary } from "@/lib/people/types";
import { PersonAvatar } from "./avatar";
import { ago, daysWords } from "./format";

type Props = {
  people: PersonSummary[];
  center: CenterOption | null;
  /** personId → days since last contact (null = never logged), for people who are overdue. */
  overdue: Map<string, number | null>;
};

const EASE = [0.22, 1, 0.36, 1] as const;
const MOVE = { duration: 0.32, ease: EASE };
/** Each person's slot: avatar plus the name under it. Keeps names from touching. */
const SLOT = 36;
/** The map never grows taller than this; bigger households scale down to fit. */
const MAX_H = 540;
const CENTER = 50;
const PAD = 16;

function avatarSize(count: number, max: number): number {
  if (max <= 0 || count <= 0) return 34;
  return Math.round(34 + 14 * Math.sqrt(Math.min(count, max) / max));
}

const firstName = (label: string) => {
  const parts = label.replace(/^(Mr|Mrs|Ms|Dr)\.?\s+/i, "").trim().split(/\s+/);
  return parts[0] ?? label;
};

function describe(p: PersonSummary, overdueDays: number | null | undefined): string {
  const latest = p.wellbeing[p.wellbeing.length - 1];
  const parts = [
    p.label,
    p.relation?.label ?? p.kindLabel,
    p.householdMember ? "member of this graph" : null,
    `last in touch ${ago(p.lastContactAt)}`,
    latest ? `feeling ${WELLBEING_WORDS[latest.score].toLowerCase()}` : "no check-in yet",
  ];
  if (overdueDays !== undefined) parts.push("longer than usual since you were in touch");
  return parts.filter(Boolean).join(", ");
}

/**
 * The people around one person as a radial map: the centre person in the middle, one orbit per circle (family
 * closest), each person as their own-colour avatar. Avatar size is how often you're in touch; the dot is their last
 * check-in; a dashed amber ring means it has been longer than usual. Positions animate when filters change.
 */
export function CirclesView({ people, center, overdue }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [active, setActive] = useState<string | null>(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.round(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const centerId = center?.id;
  const others = useMemo(() => people.filter((p) => p.id !== centerId), [people, centerId]);
  const maxCount = useMemo(() => Math.max(0, ...others.map((p) => p.contactCount90)), [others]);
  // A short force simulation runs inside: compute once per data change, never on hover.
  const layout = useMemo(() => layoutCircles(
    others.map((p) => ({ id: p.id, circle: p.circle, r: SLOT, sortKey: `${p.kind ?? "~"}:${p.label}` })),
    { centerRadius: CENTER, ringGap: 2 },
  ), [others]);
  const pos = useMemo(() => new Map(layout.placed.map((p) => [p.id, p])), [layout]);

  const E = Math.max(layout.extent, CENTER + 40) + PAD;
  const size = 2 * E;
  const scale = width ? Math.min(1, width / size, MAX_H / size) : 1;
  const activeP = active ? others.find((p) => p.id === active) : null;
  const activePos = active ? pos.get(active) : null;
  const centerLabel = center ? (center.isViewer ? "You" : center.label) : "Your family";

  return (
    <div ref={wrap} className="relative w-full" style={{ height: size * scale }}>
      <div className="absolute left-1/2 top-0 origin-top" style={{ width: size, height: size, transform: `translateX(-50%) scale(${scale})` }}>
        <svg width={size} height={size} viewBox={`${-E} ${-E} ${size} ${size}`} className="absolute inset-0 overflow-visible" aria-hidden="true">
          <AnimatePresence initial={false}>
            {layout.rings.map((r) => (
              <motion.g key={r.key} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={MOVE}>
                {/* the orbit: a soft tonal track people sit on, no outline */}
                <motion.circle initial={false} animate={{ r: r.radius }} transition={MOVE} fill="none" stroke="var(--surface-2)" strokeWidth={SLOT * 1.15} opacity={0.5} />
                <motion.text initial={false} animate={{ y: -r.radius }} transition={MOVE} dy="0.35em" textAnchor="middle"
                  fontSize={12} fontWeight={500} fill="var(--muted)">{r.label}</motion.text>
              </motion.g>
            ))}
          </AnimatePresence>
        </svg>

        {/* centre */}
        <div className="absolute flex flex-col items-center" style={{ left: E, top: E, transform: "translate(-50%, -50%)" }}>
          {center
            ? <Avatar id={center.id} name={center.label} size={64} className="ring-4 ring-surface" />
            : <span className="inline-flex size-16 items-center justify-center rounded-full bg-fg text-sm font-semibold text-bg">Us</span>}
          <span className="absolute top-full mt-1.5 whitespace-nowrap text-sm font-semibold">{centerLabel}</span>
        </div>

        <AnimatePresence initial={false}>
          {others.map((p) => {
            const pt = pos.get(p.id);
            if (!pt) return null;
            const od = overdue.get(p.id);
            const isOverdue = overdue.has(p.id);
            const s = avatarSize(p.contactCount90, maxCount);
            const latest = p.wellbeing[p.wellbeing.length - 1]?.score ?? null;
            return (
              <motion.div key={p.id} className="absolute left-0 top-0"
                initial={{ opacity: 0, scale: 0.85, x: E + pt.x, y: E + pt.y }}
                animate={{ opacity: 1, scale: 1, x: E + pt.x, y: E + pt.y }}
                exit={{ opacity: 0, scale: 0.85, transition: { duration: 0.15 } }}
                transition={MOVE}>
                <Link href={`/people/${p.id}`} aria-label={describe(p, od)}
                  onMouseEnter={() => setActive(p.id)} onMouseLeave={() => setActive((a) => (a === p.id ? null : a))}
                  onFocus={() => setActive(p.id)} onBlur={() => setActive((a) => (a === p.id ? null : a))}
                  className="group absolute flex w-[84px] -translate-x-1/2 flex-col items-center rounded-lg outline-offset-4"
                  style={{ top: -s / 2 }}>
                  <PersonAvatar id={p.id} label={p.label} size={s} score={latest} overdue={isOverdue}
                    className="transition-transform duration-150 ease-out group-hover:scale-[1.06] group-active:scale-[0.97]" />
                  <span className="mt-1.5 max-w-full truncate text-[13px] font-medium leading-tight">{firstName(p.label)}</span>
                  {isOverdue
                    ? <span className="text-xs leading-tight text-warn">{od == null ? "never logged" : daysWords(od)}</span>
                    : p.householdMember && <span className="text-xs leading-tight text-muted">member</span>}
                </Link>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>

      <AnimatePresence>
        {activeP && activePos && (
          <motion.div key={activeP.id} role="tooltip"
            initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, transition: { duration: 0.1 } }}
            transition={{ duration: 0.15, ease: EASE }}
            className="pointer-events-none absolute z-10 w-60 rounded-lg bg-surface p-3 text-sm shadow-float"
            style={{
              left: Math.min(Math.max((width - size * scale) / 2 + (E + activePos.x) * scale - 120, 0), Math.max(width - 240, 0)),
              top: (E + activePos.y + SLOT + 14) * scale,
            }}>
            <Tip p={activeP} overdueDays={overdue.has(activeP.id) ? overdue.get(activeP.id) ?? null : undefined} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Tip({ p, overdueDays }: { p: PersonSummary; overdueDays: number | null | undefined }) {
  const latest = p.wellbeing[p.wellbeing.length - 1];
  return (
    <>
      <div className="font-medium">{p.label}</div>
      <div className="text-muted">{p.relation?.label ?? p.kindLabel ?? "No relation recorded"}</div>
      {p.householdMember && <div className="text-[13px] text-muted">Member of this graph</div>}
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[13px]">
        <dt className="text-muted">In touch</dt>
        <dd className={overdueDays !== undefined ? "text-warn" : undefined} suppressHydrationWarning>{ago(p.lastContactAt)}</dd>
        <dt className="text-muted">Feeling</dt>
        <dd>{latest ? WELLBEING_WORDS[latest.score] : <span className="text-muted">No check-in yet</span>}</dd>
      </dl>
    </>
  );
}

/** The key under the map. Each mark is the real mark, scaled down. */
export function CirclesLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px] text-muted">
      <span className="inline-flex items-center gap-2">
        <span aria-hidden="true" className="inline-flex items-end gap-0.5"><span className="size-2.5 rounded-full bg-line" /><span className="size-3.5 rounded-full bg-line" /></span>
        Bigger means more contact lately
      </span>
      <span className="inline-flex items-center gap-2">
        <span aria-hidden="true" className="inline-flex gap-0.5">
          <span className="size-2 rounded-full bg-[var(--wb-good)]" /><span className="size-2 rounded-full bg-[var(--wb-neutral)]" /><span className="size-2 rounded-full bg-[var(--wb-warn)]" />
        </span>
        Last check-in
      </span>
      <span className="inline-flex items-center gap-2">
        <span aria-hidden="true" className="size-3.5 rounded-full border-[1.5px] border-dashed border-warn" />
        Longer than usual since you were in touch
      </span>
    </div>
  );
}
