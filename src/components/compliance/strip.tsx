"use client";
/**
 * The compliance strip at the top of a page or document: "Checked against 2 corpora: 1 blocker, 2 notes". It opens to
 * the notes themselves. Quiet when there is nothing to say; never a blocking banner.
 */
import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { clsx } from "clsx";
import { ChevronDown, LoaderCircle, Scale, ShieldCheck } from "lucide-react";
import { useT } from "@/lib/i18n/client";
import type { Counts, FindingView } from "./api";
import { FindingIcon, FindingNote, findingHeadline } from "./finding-note";

const EASE = [0.22, 1, 0.36, 1] as const;

export type StripState = {
  phase: "idle" | "checking";
  corpora: { id: string; name: string }[];
  findings: FindingView[];
  counts: Counts;
  status?: string | null;
  checked: boolean;
};

export function stripWords(t: ReturnType<typeof useT>, s: Pick<StripState, "corpora" | "counts">): string {
  const head = t("compliance.strip.checkedAgainst", { count: s.corpora.length });
  const c = s.counts;
  const parts: string[] = [];
  if (c.blocker) parts.push(t("compliance.strip.blockers", { count: c.blocker }));
  const notes = c.open - c.blocker;
  if (notes) parts.push(t("compliance.strip.notes", { count: notes }));
  if (c.accepted) parts.push(t("compliance.strip.accepted", { count: c.accepted }));
  return `${head}: ${parts.length ? parts.join(", ") : t("compliance.strip.clean")}`;
}

export function ComplianceStrip({ state, canEdit, onFocus, onSuggest, onChanged, pendingFor, className, sticky = false }: {
  state: StripState;
  canEdit: boolean;
  /** Clicking a note's headline: show it in the text. */
  onFocus?: (f: FindingView) => void;
  onSuggest?: (f: FindingView) => void;
  onChanged?: (findings: FindingView[]) => void;
  /** A suggested fix waiting to be accepted for this note (shown inside it). */
  pendingFor?: (f: FindingView) => { onAccept: () => void; onDiscard: () => void; manual?: boolean } | null;
  className?: string;
  sticky?: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const { phase, corpora, counts, findings } = state;
  if (!corpora.length && phase === "idle" && !findings.length) return null;
  const tone = counts.blocker ? "text-danger" : counts.open ? "text-warn" : "text-muted";
  const Icon = counts.open ? Scale : ShieldCheck;
  const label = phase === "checking" && !state.checked
    ? t("compliance.strip.checking", { corpora: corpora.map((c) => c.name).join(", ") || "…" })
    : stripWords(t, state);
  return (
    <div className={clsx("min-w-0 text-sm", sticky && "sticky top-[105px] z-10 lg:top-[49px]", className)}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} disabled={!findings.length}
        className={clsx("flex w-full items-center gap-2 rounded-md px-3 py-2 text-left transition-colors", findings.length ? "hover:bg-surface-2" : "cursor-default",
          counts.blocker ? "bg-danger-tint/60" : counts.open ? "bg-warn-tint/60" : "bg-surface-2/60")}>
        {phase === "checking" ? <LoaderCircle aria-hidden className="size-4 shrink-0 animate-spin text-muted" /> : <Icon aria-hidden className={clsx("size-4 shrink-0", tone)} />}
        <span className={clsx("min-w-0 flex-1", counts.open ? "text-fg" : "text-muted")} aria-live="polite">{label}</span>
        {state.corpora.length > 0 && <span className="hidden min-w-0 max-w-[40%] truncate text-xs text-muted sm:inline">{state.corpora.map((c) => c.name).join(", ")}</span>}
        {findings.length > 0 && <ChevronDown aria-hidden className={clsx("size-4 shrink-0 text-muted transition-transform duration-150", open && "rotate-180")} />}
      </button>
      {state.status === "unavailable" && <p className="px-3 pt-1 text-xs text-muted">{t("compliance.strip.unavailable")}</p>}
      {state.status === "partial" && <p className="px-3 pt-1 text-xs text-muted">{t("compliance.strip.partial")}</p>}
      <AnimatePresence initial={false}>
        {open && findings.length > 0 && (
          <motion.div key="list" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: EASE }} className="overflow-hidden">
            <ul className="mt-1 max-h-[60vh] space-y-1 overflow-auto rounded-md bg-surface p-2 shadow-float">
              {findings.map((f) => (
                <li key={f.id}>
                  <details className="group rounded-md open:bg-surface-2/40">
                    <summary className="flex cursor-pointer list-none items-start gap-2 rounded-md px-2 py-1.5 hover:bg-surface-2/70"
                      onClick={() => onFocus?.(f)}>
                      <FindingIcon f={f} className="mt-0.5 size-4" />
                      <span className="min-w-0 flex-1">
                        <span className={clsx("block", f.status === "accepted" ? "text-muted" : "text-fg")}>{findingHeadline(t, f)}</span>
                        {f.explanation && <span className="block truncate text-xs text-muted group-open:hidden">{f.explanation}</span>}
                      </span>
                    </summary>
                    <div className="px-2 pb-2 pt-1"><FindingNote f={f} canEdit={canEdit} compact onSuggest={onSuggest} onChanged={onChanged} pending={pendingFor?.(f) ?? null} /></div>
                  </details>
                </li>
              ))}
            </ul>
            <p className="px-3 pt-1 text-xs text-muted">{t("compliance.strip.advisory")}</p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
