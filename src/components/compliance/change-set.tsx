"use client";
/**
 * A compliance line for a change set (/changes/[id]): the proposed facts and decisions, as readable sentences, checked
 * against the graph's corpora. Advisory only — delivering stays the person's call. Render it anywhere on the page:
 *   <ChangeSetCompliance changeSetId={set.id} />
 */
import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { clsx } from "clsx";
import { ChevronRight, LoaderCircle, Scale, ShieldCheck } from "lucide-react";
import { useT } from "@/lib/i18n/client";
import { checkTarget, type CheckResult, type FindingView } from "./api";
import { FindingNote } from "./finding-note";

const EASE = [0.22, 1, 0.36, 1] as const;

export function ChangeSetCompliance({ changeSetId, className }: { changeSetId: string; className?: string }) {
  const t = useT();
  const [result, setResult] = useState<CheckResult | null>(null);
  const [checking, setChecking] = useState(true);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let live = true;
    void checkTarget({ targetType: "change_set", targetId: changeSetId, missing: false }).then((r) => {
      if (!live) return;
      setChecking(false);
      if (r.ok) setResult(r.data.result);
    });
    return () => { live = false; };
  }, [changeSetId]);

  if (checking) return <p className={clsx("flex items-center gap-2 text-sm text-muted", className)}><LoaderCircle aria-hidden className="size-3.5 animate-spin" />{t("compliance.changes.checking")}</p>;
  if (!result || !result.corpora.length || result.status === "skipped") return null;
  const openOnes = result.findings.filter((f) => f.status === "open");
  if (!openOnes.length) {
    if (result.status === "unavailable") return null;
    return <p className={clsx("flex items-center gap-2 text-sm text-muted", className)}><ShieldCheck aria-hidden className="size-3.5" />{t("compliance.changes.ok", { count: result.corpora.length })}</p>;
  }
  const blocker = openOnes.some((f) => f.rule.severity === "blocker");
  const setFindings = (findings: FindingView[]) => setResult((r) => r && { ...r, findings });
  return (
    <div className={className}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
        className={clsx("-ml-1.5 inline-flex min-h-7 items-center gap-1.5 rounded-md px-1.5 text-left text-sm transition-colors hover:bg-surface-2", blocker ? "text-danger" : "text-warn")}>
        <ChevronRight aria-hidden className={clsx("size-3.5 shrink-0 transition-transform duration-150", open && "rotate-90")} />
        <Scale aria-hidden className="size-3.5 shrink-0" />
        {t("compliance.changes.foundCount", { count: openOnes.length })}
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div key="notes" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: EASE }} className="overflow-hidden">
            <div className="mt-2 space-y-4 rounded-lg bg-surface p-4">
              {result.findings.map((f) => <FindingNote key={f.id} f={f} canEdit compact onChanged={setFindings} />)}
              <p className="text-xs text-muted">{t("compliance.changes.advisory")}</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
