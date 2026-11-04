"use client";
/**
 * Under an assistant's answer: "Compliance: conflicts with ADR governance 4.2", opening to the explanation and the
 * rule's own words with its source. The check runs on the server after the answer is written; a fresh answer waits
 * for it here (a few seconds), an older one shows what was found then.
 */
import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { clsx } from "clsx";
import { ChevronRight, LoaderCircle, Scale, ShieldCheck } from "lucide-react";
import { useT } from "@/lib/i18n/client";
import { storedFindings, type FindingView, type LastRun } from "./api";
import { FindingNote } from "./finding-note";

const EASE = [0.22, 1, 0.36, 1] as const;
const WAIT_MS = 90_000;

export function AnswerCompliance({ messageId, createdAt }: { messageId: string; createdAt: string }) {
  const t = useT();
  const [findings, setFindings] = useState<FindingView[] | null>(null);
  const [run, setRun] = useState<LastRun>(null);
  const [waiting, setWaiting] = useState(false);
  const [open, setOpen] = useState(false);
  const local = messageId.startsWith("local-") || messageId === "pending";

  useEffect(() => {
    if (local) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const born = new Date(createdAt).getTime();
    const poll = async () => {
      const r = await storedFindings("message", messageId);
      if (!live || !r.ok) return;
      const finished = r.data.run && r.data.run.status !== "running";
      if (finished) { setRun(r.data.run); setFindings(r.data.findings); setWaiting(false); return; }
      // No corpora apply to answers, or the answer is old and was never checked: nothing to say.
      if (!r.data.effective.length || Date.now() - born > WAIT_MS) { setWaiting(false); return; }
      setWaiting(true);
      timer = setTimeout(() => void poll(), 2500);
    };
    void poll();
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, [messageId, createdAt, local]);

  if (local) return null;
  if (waiting && !run) {
    return <p className="mt-4 flex items-center gap-2 text-sm text-muted"><LoaderCircle aria-hidden className="size-3.5 animate-spin" />{t("compliance.chat.checking")}</p>;
  }
  if (!run || !findings) return null;
  const openOnes = findings.filter((f) => f.status === "open");
  const n = run.corpora.length;
  if (!openOnes.length && run.status === "failed") return null;
  if (!openOnes.length) {
    return <p className="mt-4 flex items-center gap-2 text-sm text-muted"><ShieldCheck aria-hidden className="size-3.5" />{t("compliance.chat.ok", { count: n })}</p>;
  }
  const first = openOnes[0];
  const what = `${first.rule.corpusName} ${first.rule.ref}`;
  const more = openOnes.length > 1 ? ` ${t("compliance.chat.more", { count: openOnes.length - 1 })}` : "";
  const sure = openOnes.some((f) => f.verdict === "non_compliant");
  const blocker = openOnes.some((f) => f.rule.severity === "blocker");
  return (
    <div className="mt-4">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
        className={clsx("-ml-1.5 inline-flex min-h-7 items-center gap-1.5 rounded-md px-1.5 text-left text-sm transition-colors hover:bg-surface-2", blocker ? "text-danger" : "text-warn")}>
        <ChevronRight aria-hidden className={clsx("size-3.5 shrink-0 transition-transform duration-150", open && "rotate-90")} />
        <Scale aria-hidden className="size-3.5 shrink-0" />
        <span>{t(sure ? "compliance.chat.conflicts" : "compliance.chat.unclear", { what })}{more}</span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div key="notes" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: EASE }} className="overflow-hidden">
            <div className="mt-2 space-y-4 rounded-lg bg-surface p-4">
              {findings.map((f) => <FindingNote key={f.id} f={f} canEdit compact onChanged={setFindings} />)}
              <p className="text-xs text-muted">{t("compliance.strip.checkedAgainst", { count: n })}: {run.corpora.map((c) => c.name).join(", ")}. {t("compliance.strip.advisory")}</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
