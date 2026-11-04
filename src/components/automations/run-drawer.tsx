"use client";
import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { X } from "lucide-react";
import { CitationChip, IconButton } from "@/components/ui";
import type { RunDTO } from "@/lib/automations/automations";
import { api, StatusDot, statusLabel, when, whenInline } from "./bits";
import { SuggestionCard, type SuggestionView } from "./suggestion-card";

type RunDetail = { run: RunDTO; suggestions: SuggestionView[] };

/** A run, opened from Activity or a list: what it did, what it skipped, where it looked, what it suggested. */
export function RunDrawer({ runId, onClose }: { runId: string | null; onClose: () => void }) {
  const [data, setData] = useState<RunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!runId) return;
    let live = true;
    setData(null); setError(null);
    const load = () => api<RunDetail>(`/api/activity/runs/${runId}`).then((d) => {
      if (!live) return;
      setData(d);
      if (d.run.status === "running") setTimeout(load, 2000);
    }).catch((e) => live && setError(e instanceof Error ? e.message : "Couldn't load this run."));
    void load();
    return () => { live = false; };
  }, [runId]);

  useEffect(() => {
    if (!runId) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [runId, onClose]);

  return (
    <AnimatePresence>
      {runId && (
        <>
          <motion.div key="scrim" className="fixed inset-0 z-40 bg-fg/20" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }} onClick={onClose} />
          <motion.aside key="panel" role="dialog" aria-modal="true" aria-label="Run details"
            className="fixed inset-y-0 right-0 z-50 flex w-full max-w-[480px] flex-col overflow-y-auto bg-bg p-5 shadow-float"
            initial={{ x: 40, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: 40, opacity: 0 }} transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}>
            <div className="mb-4 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="text-lg font-semibold">{data?.run.name ?? "Run"}</h2>
                {data && (
                  <p className="mt-0.5 flex items-center gap-1.5 text-sm text-muted">
                    <StatusDot status={data.run.status} />{statusLabel(data.run.status)}, {whenInline(data.run.startedAt)}
                    {data.run.source === "recipe" ? ", recipe" : ""}
                  </p>
                )}
              </div>
              <IconButton label="Close" onClick={onClose}><X className="size-4" /></IconButton>
            </div>
            {error && <p role="alert" className="text-sm text-danger">{error}</p>}
            {!data && !error && <p className="text-sm text-muted">Loading…</p>}
            {data && <RunBody d={data} />}
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}

function RunBody({ d }: { d: RunDetail }) {
  const { run } = d;
  const [hidden, setHidden] = useState<string[]>([]);
  return (
    <div className="space-y-5">
      {run.summary && !(run.output ?? "").startsWith(run.summary.replace(/[.!?]$/, "")) && <p>{run.summary}</p>}
      {run.error && run.status === "failed" && <p className="rounded-md bg-danger-tint px-3 py-2 text-sm text-danger">What went wrong: {run.error}</p>}
      {run.output && run.output !== run.summary && (
        <div className="whitespace-pre-line rounded-lg bg-surface p-4 text-[15px] leading-relaxed">{run.output}</div>
      )}
      {run.citations.length > 0 && (
        <section>
          <h3 className="mb-1.5 text-sm font-medium">Where it looked</h3>
          <div className="flex flex-wrap gap-1.5">
            {run.citations.map((c) => <CitationChip key={`${c.n}-${c.title}`} n={c.n} title={c.title} confidence={c.confidence}
              href={c.sourceId ? `/library/${c.sourceId}` : c.nodeId ? `/node/${c.nodeId}` : undefined} />)}
          </div>
        </section>
      )}
      {run.steps.length > 0 && (
        <section>
          <h3 className="mb-1.5 text-sm font-medium">What it did</h3>
          <ol className="space-y-1 text-sm text-muted">
            {run.steps.map((s, i) => <li key={i} className="flex gap-2"><span className="tabular-nums">{i + 1}.</span><span>{s.label}{s.ms ? ` (${(s.ms / 1000).toFixed(1)}s)` : ""}</span></li>)}
          </ol>
        </section>
      )}
      <section>
        <h3 className="mb-1.5 text-sm font-medium">Skipped because nobody was watching</h3>
        {run.skipped.length ? (
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted">{run.skipped.map((s, i) => <li key={i}>{s}</li>)}</ul>
        ) : <p className="text-sm text-muted">Nothing. It only read and suggested.</p>}
      </section>
      <section>
        <h3 className="mb-1.5 text-sm font-medium">Suggestions from this run</h3>
        {d.suggestions.length ? (
          <div className="space-y-2">
            {d.suggestions.filter((s) => !hidden.includes(s.id)).map((s) => s.status === "pending"
              ? <SuggestionCard key={s.id} s={s} compact onDone={(id) => setHidden((h) => [...h, id])} />
              : <p key={s.id} className="text-sm text-muted">{s.title}: {s.status === "approved" ? "approved" : s.status === "denied" ? "dismissed" : "expired"}</p>)}
          </div>
        ) : <p className="text-sm text-muted">None.</p>}
      </section>
    </div>
  );
}
