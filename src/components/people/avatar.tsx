import { clsx } from "clsx";
import { Avatar } from "@/components/ui";
import { WELLBEING_VAR, wellbeingBand, WELLBEING_WORDS } from "@/lib/people/circles";

/**
 * A person's own-colour avatar (from the UI kit) with their latest check-in as a small status dot, and an optional
 * dashed amber ring when you haven't been in touch for longer than usual.
 */
export function PersonAvatar({ id, label, size = 32, score, overdue, className }: {
  id: string; label: string; size?: number; score?: number | null; overdue?: boolean; className?: string;
}) {
  const band = wellbeingBand(score);
  const dot = Math.min(14, Math.max(8, Math.round(size * 0.26)));
  return (
    <span className={clsx("relative inline-flex shrink-0", className)} style={{ width: size, height: size }}>
      <Avatar id={id} name={label} size={size} />
      {overdue && (
        <span aria-hidden="true" className="pointer-events-none absolute -inset-[4px] rounded-full border-[1.5px] border-dashed border-warn" />
      )}
      {band !== "none" && (
        <span aria-hidden="true" className="absolute bottom-0 right-0 rounded-full ring-2 ring-[var(--ring-bg,var(--surface))]"
          style={{ width: dot, height: dot, background: WELLBEING_VAR[band], transform: `translate(${size > 48 ? -3 : 1}px, ${size > 48 ? -3 : 1}px)` }} />
      )}
    </span>
  );
}

/** "Good" with its status dot; "No check-in yet" in grey. */
export function WellbeingWord({ score, className }: { score: number | null | undefined; className?: string }) {
  if (score == null) return <span className={clsx("text-muted", className)}>No check-in yet</span>;
  const band = wellbeingBand(score);
  return (
    <span className={clsx("inline-flex items-center gap-1.5", band === "warn" && "text-danger", className)}>
      <span aria-hidden="true" className="inline-block size-2 rounded-full" style={{ background: WELLBEING_VAR[band] }} />
      {WELLBEING_WORDS[score]}
    </span>
  );
}
