"use client";
/**
 * "Rebuild the timeline from the library": starts the background re-read and shows its progress in one line.
 * What it finds arrives as proposals to review; it never adds to the graph by itself.
 */
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { clsx } from "clsx";
import { LoaderCircle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui";
import { useT } from "@/lib/i18n/client";

type Progress = {
  status: "running" | "done" | "failed"; total: number; done: number; dates: number; threads: number; joined: number;
  proposals: number; proposedChanges: number; skipped: number; errors: number; muxUp: boolean; changeSetIds: string[];
  error: string | null; finishedAt: string | null;
};

export function RebuildButton({ onDone, className, variant = "ghost" }: { onDone?: () => void; className?: string; variant?: "ghost" | "secondary" }) {
  const t = useT();
  const [p, setP] = useState<Progress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const wasRunning = useRef(false);

  const poll = useCallback(async () => {
    try {
      const r = await fetch("/api/timeline/rebuild", { cache: "no-store" });
      const body = await r.json().catch(() => null);
      if (r.ok) setP(body?.progress ?? null);
    } catch { /* offline: try again on the next tick */ }
  }, []);

  useEffect(() => { void poll(); }, [poll]);
  useEffect(() => {
    if (p?.status !== "running") {
      if (wasRunning.current && p) onDone?.();
      wasRunning.current = false;
      return;
    }
    wasRunning.current = true;
    const t = setInterval(() => void poll(), 1500);
    return () => clearInterval(t);
  }, [p, poll, onDone]);

  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      const r = await fetch("/api/timeline/rebuild", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const body = await r.json().catch(() => null);
      if (!r.ok) throw new Error(body?.error ?? t("timeline.rebuild.didntStart"));
      setP(body.progress);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("timeline.rebuild.didntStart"));
    } finally {
      setStarting(false);
    }
  };

  const running = p?.status === "running";
  return (
    <div className={clsx("flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1", className)}>
      <Button variant={variant} size="md" onClick={() => void start()} disabled={running || starting}
        title={t("timeline.rebuild.hint")}>
        {running || starting ? <LoaderCircle aria-hidden className="size-4 motion-safe:animate-spin" /> : <RefreshCw aria-hidden className="size-4" />}
        {t("timeline.rebuild.button")}
      </Button>
      <span className="min-w-0 text-sm text-muted" role="status" aria-live="polite">
        {error ? <span className="text-danger">{error}</span> : p ? <ProgressLine p={p} /> : null}
      </span>
    </div>
  );
}

function ProgressLine({ p }: { p: Progress }) {
  const t = useT();
  if (p.status === "running") return <span className="tabular-nums">{t("timeline.rebuild.reading", { n: Math.min(p.done + 1, p.total || 1), total: p.total || "…" })}</span>;
  if (p.status === "failed") return <span className="text-danger">{t("timeline.rebuild.stopped", { error: p.error ?? t("timeline.rebuild.somethingWrong") })}</span>;
  const conversations = p.threads + p.joined;
  const found = [
    p.dates ? t("timeline.rebuild.dates", { count: p.dates }) : null,
    conversations ? t("timeline.rebuild.conversations", { count: conversations }) : null,
  ].filter((x): x is string => !!x);
  const what = found.length === 2 ? t("timeline.rebuild.and", { a: found[0], b: found[1] }) : found[0];
  return (
    <span>
      {what ? `${t("timeline.rebuild.found", { what })} ` : p.proposedChanges === 0 ? `${t("timeline.rebuild.allKnown")} ` : ""}
      {p.proposals === 0 && p.proposedChanges > 0 && `${t("timeline.rebuild.waiting", { count: p.proposedChanges })} `}
      {p.proposals > 0 && (
        <Link href={p.changeSetIds.length === 1 ? `/changes/${p.changeSetIds[0]}` : "/changes"} className="font-medium text-accent hover:underline">
          {t("timeline.rebuild.toReview", { count: p.proposals })}
        </Link>
      )}
      {!p.muxUp && ` ${t("timeline.rebuild.muxDown")}`}
    </span>
  );
}
