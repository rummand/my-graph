"use client";
import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Bookmark, CalendarDays, ChevronRight, FileText, ListChecks, PenLine, Search, Users } from "lucide-react";
import { clsx } from "clsx";
import type { AssistantStep } from "@/db/schema";
import { workedLabel } from "@/lib/assistant/steps";

const EASE = [0.22, 1, 0.36, 1] as const;

const ICON: Record<AssistantStep["kind"], typeof Search> = {
  search: Search, read: FileText, timeline: CalendarDays, people: Users, memory: Bookmark, write: PenLine, think: ListChecks, other: ListChecks,
};

function StepList({ steps, live }: { steps: AssistantStep[]; live?: boolean }) {
  return (
    <ul className="space-y-1.5" aria-label="What the assistant did">
      {steps.map((s, i) => {
        const Icon = ICON[s.kind] ?? ListChecks;
        return (
          <motion.li key={`${i}-${s.label}`} initial={live ? { opacity: 0, y: 4 } : false} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.18, ease: EASE }}
            className="flex items-center gap-2.5 text-sm text-muted">
            <Icon aria-hidden className="size-3.5 shrink-0" />
            <span className="min-w-0">{s.label}</span>
          </motion.li>
        );
      })}
    </ul>
  );
}

/** While answering: the steps as they happen, then "Writing the answer…". */
export function LiveSteps({ steps, writing }: { steps: AssistantStep[]; writing: boolean }) {
  return (
    <div role="status" className="space-y-1.5">
      {steps.length === 0 ? (
        <p className="flex items-center gap-2.5 text-sm text-muted"><Dots /> Looking through your graph…</p>
      ) : (
        <>
          <StepList steps={steps} live />
          {!writing && <p className="flex items-center gap-2.5 text-sm text-muted"><Dots /> Writing the answer…</p>}
        </>
      )}
    </div>
  );
}

function Dots() {
  return (
    <span className="inline-flex w-3.5 justify-center gap-0.5" aria-hidden>
      {[0, 1, 2].map((i) => (
        <motion.span key={i} className="size-1 rounded-full bg-muted"
          animate={{ opacity: [0.25, 1, 0.25] }} transition={{ duration: 1.2, repeat: Infinity, delay: i * 0.16, ease: "easeInOut" }} />
      ))}
    </span>
  );
}

/** Above a finished answer: "Worked for 4s, 3 steps", which opens the list of steps. */
export function WorkedLine({ steps, thoughtMs, streaming }: { steps: AssistantStep[]; thoughtMs: number | null; streaming?: boolean }) {
  const [open, setOpen] = useState(false);
  if (!steps.length && thoughtMs == null) return null;
  const label = streaming ? `Working, ${steps.length} ${steps.length === 1 ? "step" : "steps"} so far` : workedLabel(thoughtMs, steps);
  return (
    <div className="mb-3">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} disabled={!steps.length}
        className="-ml-1.5 inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-sm text-muted transition-colors hover:bg-surface-2 hover:text-fg disabled:hover:bg-transparent">
        <ChevronRight aria-hidden className={clsx("size-3.5 transition-transform duration-150", open && "rotate-90", !steps.length && "invisible")} />
        {label}
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div key="steps" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: EASE }} className="overflow-hidden">
            <div className="pb-1 pl-5 pt-1.5"><StepList steps={steps} /></div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
