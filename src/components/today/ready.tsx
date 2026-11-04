"use client";
import { useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import { ArrowRight, BookOpen, Loader2, X } from "lucide-react";
import { clsx } from "clsx";
import { CitationChip, IconButton } from "@/components/ui";
import type { Citation } from "@/db/schema";
import { splitCitations } from "@/lib/briefs/context";
import { useT } from "@/lib/i18n/client";
import { hrefs, TodaySection } from "./section";

type Question = { q: string; why: string };
type RecipeChip = { id: string; name: string; description: string };
type RunResult = { recipeId: string; name: string; text: string; citations: Citation[]; runId: string | null };

function citationHref(c: Citation): string | undefined {
  if (c.sourceId) return hrefs.source(c.sourceId);
  if (c.nodeId) return hrefs.node(c.nodeId);
  return undefined;
}

function Answer({ text, citations }: { text: string; citations: Citation[] }) {
  const byN = new Map(citations.map((c) => [c.n, c]));
  return (
    <div className="max-w-[68ch] space-y-2 leading-relaxed">
      {text.split("\n").filter((l) => l.trim()).map((line, i) => (
        <p key={i}>
          {splitCitations(line).map((part, j) => {
            if (part.kind === "text") return <span key={j}>{part.text}</span>;
            const c = byN.get(part.n);
            return c ? <span key={j} className="mx-0.5"><CitationChip n={c.n} title={c.title} confidence={c.confidence} href={citationHref(c)} /></span> : null;
          })}
        </p>
      ))}
    </div>
  );
}

/**
 * "Ready when you are": a few questions worth asking now, written from the graph's own data (and the graph template's
 * examples), and the saved recipes, which run right here and show their answer with sources.
 */
export function ReadyWhenYouAre({ questions, recipes }: { questions: Question[]; recipes: RecipeChip[] | null }) {
  const t = useT();
  const [running, setRunning] = useState<string | null>(null);
  const [result, setResult] = useState<RunResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(r: RecipeChip) {
    setRunning(r.id); setError(null);
    try {
      const res = await fetch(`/api/recipes/${encodeURIComponent(r.id)}/run`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const body = (await res.json().catch(() => ({}))) as { runId?: string; text?: string; citations?: Citation[]; error?: string };
      if (!res.ok || typeof body.text !== "string") throw new Error(body.error ?? t("today.ready.didntRun", { name: r.name }));
      setResult({ recipeId: r.id, name: r.name, text: body.text.trim() || t("today.ready.nothing"), citations: body.citations ?? [], runId: body.runId ?? null });
    } catch (e) {
      setError(e instanceof TypeError ? t("today.error.offline") : e instanceof Error ? e.message : t("today.ready.failed"));
    } finally {
      setRunning(null);
    }
  }

  if (!questions.length && !recipes?.length) return null;

  return (
    <TodaySection id="ready" title={t("today.ready.title")}>
      <ul className="-mx-2 grid gap-x-4 sm:grid-cols-2">
        {questions.map((q) => (
          <li key={q.q} className="min-w-0">
            <Link href={hrefs.ask(q.q)} className="group flex items-start gap-2.5 rounded-md px-2 py-2 transition-colors hover:bg-surface">
              <ArrowRight aria-hidden className="mt-1 size-4 shrink-0 text-muted transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-fg" />
              <span className="min-w-0">
                <span className="block">{q.q}</span>
                <span className="block truncate text-sm text-muted">{q.why}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>

      {recipes && recipes.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-sm text-muted">{t("today.ready.recipes")}</span>
          {recipes.slice(0, 6).map((r) => (
            <button
              key={r.id}
              type="button"
              title={r.description || undefined}
              onClick={() => run(r)}
              disabled={!!running}
              aria-busy={running === r.id || undefined}
              className={clsx(
                "inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-sm transition-colors duration-150 disabled:opacity-60",
                result?.recipeId === r.id ? "bg-fg text-bg" : "bg-surface text-fg hover:bg-surface-2",
              )}
            >
              {running === r.id ? <Loader2 aria-hidden className="size-3.5 animate-spin" /> : <BookOpen aria-hidden className="size-3.5 opacity-70" />}
              {r.name}
            </button>
          ))}
          <Link href="/automations?view=recipes" className="ml-1 text-sm text-accent hover:underline">{t("today.ready.manage")}</Link>
        </div>
      )}

      <div aria-live="polite">
        {error && <p role="alert" className="mt-3 rounded-md bg-warn-tint px-3 py-2 text-sm text-warn">{error}</p>}
        <AnimatePresence initial={false}>
          {result && (
            <motion.div key={result.recipeId + result.text.length} initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
              <div className="mt-3 rounded-lg bg-surface p-4">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <p className="text-sm text-muted">{result.name}</p>
                  <IconButton label={t("common.close")} onClick={() => setResult(null)}><X aria-hidden className="size-4" /></IconButton>
                </div>
                <Answer text={result.text} citations={result.citations} />
                {result.runId && <Link href={`/automations?run=${encodeURIComponent(result.runId)}`} className="mt-2 inline-block text-sm text-accent hover:underline">{t("today.ready.howItWorked")}</Link>}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </TodaySection>
  );
}
