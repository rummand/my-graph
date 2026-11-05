"use client";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Avatar } from "@/components/ui";
import { layoutCircles, RINGS, type RingDef } from "@/lib/people/circles";
import type { CenterOption, PersonSummary } from "@/lib/people/types";
import { kindName, wellbeingWord } from "@/lib/people/words";
import { PersonAvatar } from "./avatar";
import { useFmt, type Fmt } from "./format";
import { lastTouch, relationText } from "./people-table";
import { BAND_DRIFT, BAND_LOOK } from "@/lib/people/interactions/pure";

type Props = {
  people: PersonSummary[];
  center: CenterOption | null;
  /** The graph's rings with names in the reader's language (default: the family rings). */
  rings?: RingDef[];
  /** Family rules: the centre falls back to "Your family". */
  family?: boolean;
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

function describe(f: Fmt, p: PersonSummary, overdueDays: number | null | undefined): string {
  const { t } = f;
  const latest = p.wellbeing[p.wellbeing.length - 1];
  const parts = [
    p.label,
    relationText(f, p) ?? p.roleText ?? (p.kindLabel ? kindName(t, p.kindLabel) : null),
    p.householdMember ? t("people.map.memberOfGraph") : null,
    t("people.map.lastInTouch", { when: f.ago(lastTouch(p)) }),
    latest ? t(`people.feelingLower.${latest.score}`) : t("people.map.noCheckIn"),
  ];
  if (overdueDays !== undefined) parts.push(t("people.map.longer"));
  if (p.closeness && !p.isViewer) parts.push(t(`closeness.band.${p.closeness.band}`));
  return parts.filter(Boolean).join(", ");
}

/**
 * The people around one person as a radial map: the centre person in the middle, one orbit per circle (family
 * closest), each person as their own-colour avatar. Avatar size is how often you're in touch; the dot is their last
 * check-in; a dashed amber ring means it has been longer than usual. Positions animate when filters change.
 */
export function CirclesView({ people, center, overdue, rings = RINGS, family = true }: Props) {
  const f = useFmt();
  const { t } = f;
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
    // Within their ring, people sit further out the less you have been in touch (src/lib/people/interactions).
    others.map((p) => ({ id: p.id, circle: p.circle, r: SLOT, sortKey: `${p.kind ?? "~"}:${p.label}`, drift: p.closeness ? BAND_DRIFT[p.closeness.band] : 0 })),
    { centerRadius: CENTER, ringGap: 2, rings, driftBand: 26 },
  ), [others, rings]);
  const pos = useMemo(() => new Map(layout.placed.map((p) => [p.id, p])), [layout]);

  const E = Math.max(layout.extent, CENTER + 40) + PAD;
  const size = 2 * E;
  const scale = width ? Math.min(1, width / size, MAX_H / size) : 1;
  const activeP = active ? others.find((p) => p.id === active) : null;
  const activePos = active ? pos.get(active) : null;
  const centerLabel = center ? (center.isViewer ? t("people.you") : center.label) : t(family ? "people.map.centerFamily" : "people.map.centerGraph");

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
            : <span className="inline-flex size-16 items-center justify-center rounded-full bg-fg text-sm font-semibold text-bg">{t("people.map.us")}</span>}
          <span className="absolute top-full mt-1.5 whitespace-nowrap text-sm font-semibold">{centerLabel}</span>
        </div>

        <AnimatePresence initial={false}>
          {others.map((p) => {
            const pt = pos.get(p.id);
            if (!pt) return null;
            const od = overdue.get(p.id);
            const isOverdue = overdue.has(p.id);
            const look = p.closeness ? BAND_LOOK[p.closeness.band] : BAND_LOOK.close;
            const s = Math.round(avatarSize(p.contactCount90, maxCount) * look.scale);
            const latest = p.wellbeing[p.wellbeing.length - 1]?.score ?? null;
            return (
              <motion.div key={p.id} className="absolute left-0 top-0"
                initial={{ opacity: 0, scale: 0.85, x: E + pt.x, y: E + pt.y }}
                animate={{ opacity: look.opacity, scale: 1, x: E + pt.x, y: E + pt.y }}
                exit={{ opacity: 0, scale: 0.85, transition: { duration: 0.15 } }}
                transition={MOVE}>
                <Link href={`/people/${p.id}`} aria-label={describe(f, p, od)}
                  onMouseEnter={() => setActive(p.id)} onMouseLeave={() => setActive((a) => (a === p.id ? null : a))}
                  onFocus={() => setActive(p.id)} onBlur={() => setActive((a) => (a === p.id ? null : a))}
                  className="group absolute flex w-[84px] -translate-x-1/2 flex-col items-center rounded-lg outline-offset-4"
                  style={{ top: -s / 2 }}>
                  <PersonAvatar id={p.id} label={p.label} size={s} score={latest} overdue={isOverdue}
                    className="transition-transform duration-150 ease-out group-hover:scale-[1.06] group-active:scale-[0.97]" />
                  <span className="mt-1.5 max-w-full truncate text-[13px] font-medium leading-tight">{firstName(p.label)}</span>
                  {isOverdue
                    ? <span className="text-xs leading-tight text-warn">{od == null ? t("people.map.neverLogged") : f.daysWords(od)}</span>
                    : p.householdMember && <span className="text-xs leading-tight text-muted">{t("people.member")}</span>}
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
  const f = useFmt();
  const { t } = f;
  const latest = p.wellbeing[p.wellbeing.length - 1];
  return (
    <>
      <div className="font-medium">{p.label}</div>
      <div className="text-muted">{relationText(f, p) ?? p.roleText ?? (p.kindLabel ? kindName(t, p.kindLabel) : t("people.map.noRelation"))}</div>
      {p.householdMember && <div className="text-[13px] text-muted">{t("people.memberOfGraph")}</div>}
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[13px]">
        <dt className="text-muted">{t("people.map.inTouch")}</dt>
        <dd className={overdueDays !== undefined ? "text-warn" : undefined} suppressHydrationWarning>{f.ago(lastTouch(p))}</dd>
        <dt className="text-muted">{t("people.map.feeling")}</dt>
        <dd>{latest ? wellbeingWord(t, latest.score) : <span className="text-muted">{t("people.map.noCheckInYet")}</span>}</dd>
      </dl>
      {(p.closeness?.band === "drifting" || p.closeness?.band === "faded") && !p.isViewer && (
        <p className="mt-2 text-[13px] text-muted" suppressHydrationWarning>
          {t(`closeness.band.${p.closeness.band}`)} · {lastTouch(p) ? t("closeness.hint", { when: f.ago(lastTouch(p)) }) : t("closeness.neverHint")}
        </p>
      )}
    </>
  );
}

/** The key under the map. Each mark is the real mark, scaled down. */
export function CirclesLegend() {
  const t = useFmt().t;
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px] text-muted">
      <span className="inline-flex items-center gap-2">
        <span aria-hidden="true" className="inline-flex items-end gap-0.5"><span className="size-2.5 rounded-full bg-line" /><span className="size-3.5 rounded-full bg-line" /></span>
        {t("people.map.bigger")}
      </span>
      <span className="inline-flex items-center gap-2">
        <span aria-hidden="true" className="inline-flex gap-0.5">
          <span className="size-2 rounded-full bg-[var(--wb-good)]" /><span className="size-2 rounded-full bg-[var(--wb-neutral)]" /><span className="size-2 rounded-full bg-[var(--wb-warn)]" />
        </span>
        {t("people.map.lastCheckIn")}
      </span>
      <span className="inline-flex items-center gap-2">
        <span aria-hidden="true" className="size-3.5 rounded-full border-[1.5px] border-dashed border-warn" />
        {t("people.map.longerLegend")}
      </span>
    </div>
  );
}
