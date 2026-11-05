import Link from "next/link";
import { HeartHandshake } from "lucide-react";
import type { Viewer } from "@/lib/auth";
import { getPrefs, getT } from "@/lib/i18n";
import { formatAgo } from "@/lib/i18n/dates";
import { keepInTouchNudge } from "@/lib/people/interactions/nudge";

/** At most one "You haven't been in touch with X for a while", for someone who used to be close. Off unless turned on. */
export async function KeepInTouch({ viewer }: { viewer: Viewer }) {
  const nudge = await keepInTouchNudge(viewer).catch((e) => { console.error("[today] keep in touch failed", e); return null; });
  if (!nudge) return null;
  const [t, { locale }] = await Promise.all([getT(), getPrefs()]);
  const last = nudge.closeness.lastInTouch;
  return (
    <Link href={`/people/${nudge.id}`} className="group flex items-start gap-3 rounded-lg bg-surface px-4 py-3 transition-colors hover:bg-surface/70">
      <HeartHandshake aria-hidden className="mt-0.5 size-4 shrink-0 text-muted" />
      <span className="min-w-0">
        <span className="block font-medium group-hover:underline">{t("closeness.nudge", { name: nudge.label })}</span>
        {last && <span className="block text-sm text-muted">{t("closeness.nudgeDetail", { kind: t(`closeness.kindLower.${last.kind}`), when: formatAgo(new Date(last.at), locale) })}</span>}
      </span>
    </Link>
  );
}
