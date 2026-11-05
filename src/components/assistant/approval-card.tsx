"use client";
import { useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Check, X } from "lucide-react";
import { clsx } from "clsx";
import { Button, CitationChip } from "@/components/ui";
import type { Citation } from "@/db/schema";
import { useT } from "@/lib/i18n/client";

export type Decision = "approve" | "always" | "deny";

/**
 * The assistant asking before it writes something (Scout's approval card): what it wants to do, the exact preview
 * of what would be saved, where it came from, and Approve / Always allow / Deny. Shared by chat, Today and Automations.
 */
export function ApprovalCard({
  title, why, preview, citations = [], kindLabel, alwaysLabel, origin, onDecide, className, compact = false, labels,
}: {
  title: string;
  /** One plain sentence: why the assistant suggests this. */
  why?: ReactNode;
  /** Exactly what would be written. */
  preview?: ReactNode;
  citations?: Citation[];
  kindLabel?: string;
  /** e.g. "Always allow new reminders". Omit to hide the option. */
  alwaysLabel?: string;
  /** e.g. "From this morning's check-in". */
  origin?: string;
  onDecide: (d: Decision) => Promise<{ ok: boolean; label?: string; href?: string } | void>;
  className?: string;
  compact?: boolean;
  /** Other words for the buttons and outcomes (page actions: "Approve" / "Not now"). */
  labels?: { approve?: string; deny?: string; busy?: string; dismissed?: string; saved?: string };
}) {
  const t = useT();
  const [busy, setBusy] = useState<Decision | null>(null);
  const [done, setDone] = useState<{ d: Decision; label?: string; href?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function decide(d: Decision) {
    setBusy(d); setError(null);
    try {
      const r = await onDecide(d);
      if (r && r.ok === false) throw new Error();
      setDone({ d, label: r?.label, href: r?.href });
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : t("common.approval.failed"));
    } finally {
      setBusy(null);
    }
  }

  return (
    <motion.div layout className={clsx("rounded-lg bg-surface", compact ? "p-3" : "p-4", className)}>
      <AnimatePresence mode="wait" initial={false}>
        {done ? (
          <motion.p key="done" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex items-center gap-2 text-sm text-muted">
            {done.d === "deny" ? <X className="size-4" aria-hidden /> : <Check className="size-4 text-accent" aria-hidden />}
            {done.d === "deny" ? (labels?.dismissed ?? t("common.approval.dismissed")) : (
              <span>
                {done.label ?? labels?.saved ?? t("common.approval.saved")}{done.d === "always" && t("common.approval.alwaysAfter")}
                {done.href && <> <a href={done.href} className="text-accent hover:underline">{t("common.approval.open")}</a></>}
              </span>
            )}
          </motion.p>
        ) : (
          <motion.div key="ask" exit={{ opacity: 0 }}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                {(kindLabel || origin) && (
                  <p className="mb-0.5 text-xs text-muted">{[kindLabel, origin].filter(Boolean).join(", ")}</p>
                )}
                <p className="font-medium">{title}</p>
                {why && <p className="mt-0.5 text-sm text-muted">{why}</p>}
              </div>
            </div>
            {preview && <div className="mt-3 rounded-md bg-surface-2 px-3 py-2 text-sm">{preview}</div>}
            {citations.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {citations.slice(0, 4).map((c) => (
                  <CitationChip key={c.n} n={c.n} title={c.title} confidence={c.confidence}
                    href={c.sourceId ? `/library/${c.sourceId}` : c.nodeId ? `/node/${c.nodeId}` : undefined} />
                ))}
              </div>
            )}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={() => decide("approve")} disabled={!!busy}>{busy === "approve" ? (labels?.busy ?? t("common.approval.saving")) : (labels?.approve ?? t("common.approval.approve"))}</Button>
              {alwaysLabel && <Button size="sm" variant="secondary" onClick={() => decide("always")} disabled={!!busy}>{busy === "always" ? t("common.approval.saving") : alwaysLabel}</Button>}
              <Button size="sm" variant="ghost" onClick={() => decide("deny")} disabled={!!busy}>{labels?.deny ?? t("common.approval.deny")}</Button>
              {error && <span role="alert" className="text-sm text-danger">{error}</span>}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
