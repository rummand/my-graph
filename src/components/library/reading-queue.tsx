"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { clsx } from "clsx";
import { AlertTriangle, Clock, LoaderCircle, Play, RotateCw, X } from "lucide-react";
import { Button, IconButton } from "@/components/ui";
import type { JobView, QueueView } from "@/lib/jobs/manage";
import { stepText, type Lx } from "./i18n";

const ACTIVE_MS = 2500;
const IDLE_MS = 15_000;
const NEXT_SHOWN = 4;

/**
 * The library's reading queue: what is being read right now (with its step), how many run at once, what waits,
 * what couldn't be read, and files left stalled. Polls /api/jobs every few seconds while anything is active.
 * Shows nothing when the queue is empty and nothing needs attention.
 */
export function ReadingQueue({ L, refreshKey = 0, onSettled }: { L: Lx; refreshKey?: number; onSettled?: () => void }) {
  const { t } = L;
  const [q, setQ] = useState<QueueView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const prevActive = useRef(0);
  const onSettledRef = useRef(onSettled);
  onSettledRef.current = onSettled;

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/jobs?scope=graph", { cache: "no-store" });
      if (!res.ok) return;
      const body = (await res.json()) as QueueView;
      setQ(body);
      // A file finished (or failed): let the library list catch up.
      const active = body.running.length + body.queued.count;
      if (active < prevActive.current) onSettledRef.current?.();
      prevActive.current = active;
    } catch { /* offline: keep what is shown */ }
  }, []);

  useEffect(() => { void load(); }, [load, refreshKey]);
  const active = !!q && (q.running.length > 0 || q.queued.count > 0 || q.hidden.running + q.hidden.queued > 0);
  useEffect(() => {
    const id = setInterval(() => void load(), active ? ACTIVE_MS : IDLE_MS);
    return () => clearInterval(id);
  }, [active, load]);

  const act = async (key: string, url: string, ok?: (body: Record<string, unknown>) => string | null) => {
    setBusy(key);
    setNote(null);
    try {
      const res = await fetch(url, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) setNote({ tone: "error", text: typeof body.error === "string" ? body.error : t("library.queue.actionFailed") });
      else {
        const msg = ok?.(body);
        if (msg) setNote({ tone: "ok", text: msg });
      }
      await load();
      onSettledRef.current?.();
    } catch {
      setNote({ tone: "error", text: t("library.queue.actionFailed") });
    } finally {
      setBusy(null);
    }
  };

  if (!q) return null;
  const nothing = q.running.length === 0 && q.queued.count === 0 && q.failed.length === 0 && q.stalled === 0 && q.hidden.running + q.hidden.queued === 0;
  if (nothing && !note) return null;

  const title = (j: JobView) => j.title ?? t("library.queue.untitled");
  const resumeAll = () => act("resume", "/api/jobs/resume-stalled", (b) => {
    const n = Number(b.requeued ?? 0) + Number(b.queued ?? 0);
    return n ? t("library.queue.resumed", { count: n }) : t("library.queue.nothingToResume");
  });
  const moreQueued = q.queued.count - Math.min(q.queued.next.length, NEXT_SHOWN);

  return (
    <section aria-labelledby="reading-queue-h" className="rounded-lg bg-surface px-5 py-4 sm:px-6">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <h2 id="reading-queue-h" className="text-lg font-semibold tracking-[-0.01em]">{t("library.queue.title")}</h2>
        {q.canManage && q.stalled > 0 && (
          <Button type="button" size="sm" variant="secondary" onClick={() => void resumeAll()} disabled={busy === "resume"}>
            <Play aria-hidden className="size-3.5" />{busy === "resume" ? t("library.queue.resuming") : t("library.queue.resumeAll")}
          </Button>
        )}
      </div>

      <p className="mt-1 text-sm text-muted" aria-live="polite">
        {q.running.length > 0
          ? t("library.queue.summary", { reading: t("library.queue.reading", { count: q.running.length }), parallel: t("library.queue.parallel", { count: q.concurrency.total }) })
          : q.queued.count > 0 ? null : t("library.queue.idle")}
        {q.queued.count > 0 && <> {t("library.queue.waiting", { count: q.queued.count })}.</>}
        {q.hidden.running + q.hidden.queued > 0 && <> {t("library.queue.hidden", { count: q.hidden.running + q.hidden.queued })}</>}
        {q.doneLastHour > 0 && <> {t("library.queue.doneLastHour", { count: q.doneLastHour })}</>}
      </p>
      {(q.running.some((j) => j.heavy) || q.queued.next.some((j) => j.heavy)) && q.concurrency.heavy < q.concurrency.total && (
        <p className="mt-0.5 text-xs text-muted">{t("library.queue.heavyNote", { count: q.concurrency.heavy })}</p>
      )}
      {!q.workerUp && (q.running.length > 0 || q.queued.count > 0) && (
        <p className="mt-2 text-sm text-warn">{t("library.queue.workerDown")}</p>
      )}

      {q.running.length > 0 && (
        <ul className="mt-3 space-y-2.5">
          {q.running.map((j) => {
            const p = j.progress;
            const pct = p && typeof p.total === "number" && p.total > 1 && typeof p.done === "number" ? Math.round((p.done / p.total) * 100) : null;
            return (
              <li key={j.id} className="min-w-0">
                <div className="flex min-w-0 items-center gap-2 text-sm">
                  <LoaderCircle aria-hidden className="size-4 shrink-0 text-accent motion-safe:animate-spin" />
                  <Link href={`/library/${j.sourceId}`} className="min-w-0 truncate font-medium hover:underline" title={title(j)}>{title(j)}</Link>
                  <span className="min-w-0 flex-1 truncate text-muted">{stepText(L, p)}</span>
                  {j.attempts > 1 && <span className="hidden shrink-0 text-xs text-muted sm:inline">{t("library.queue.attempt", { attempt: j.attempts, max: j.maxAttempts })}</span>}
                </div>
                {pct !== null && (
                  <div className="ml-6 mt-1 h-1 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={stepText(L, p)}>
                    <div className="h-full rounded-full bg-accent transition-[width] duration-200 ease-out" style={{ width: `${Math.max(4, pct)}%` }} />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {q.queued.next.length > 0 && (
        <div className="mt-4">
          <h3 className="text-xs text-muted">{t("library.queue.nextUp")}</h3>
          <ul className="mt-1">
            {q.queued.next.slice(0, NEXT_SHOWN).map((j) => (
              <li key={j.id} className="flex min-w-0 items-center gap-2 py-0.5 text-sm">
                <Clock aria-hidden className={clsx("size-4 shrink-0", j.error ? "text-warn" : "text-muted")} />
                <Link href={`/library/${j.sourceId}`} className="min-w-0 truncate hover:underline" title={title(j)}>{title(j)}</Link>
                {j.error && <span className="min-w-0 flex-1 truncate text-xs text-warn" title={j.error}>{t("library.queue.retryingSoon", { reason: j.error })}</span>}
                {!j.error && <span className="flex-1" />}
                {q.canManage && (
                  <IconButton label={t("library.queue.cancelLabel", { title: title(j) })} disabled={busy === j.id} className="size-7 shrink-0"
                    onClick={() => void act(j.id, `/api/jobs/${j.id}/cancel`)}>
                    <X aria-hidden className="size-3.5" />
                  </IconButton>
                )}
              </li>
            ))}
          </ul>
          {moreQueued > 0 && <p className="mt-0.5 pl-6 text-xs text-muted">{t("library.queue.more", { count: moreQueued })}</p>}
        </div>
      )}

      {q.failed.length > 0 && (
        <div className="mt-4">
          <h3 className="text-xs text-danger">{t("library.queue.failedTitle")}</h3>
          <ul className="mt-1">
            {q.failed.slice(0, 6).map((j) => (
              <li key={j.id} className="flex min-w-0 items-center gap-2 py-0.5 text-sm">
                <AlertTriangle aria-hidden className="size-4 shrink-0 text-danger" />
                <Link href={`/library/${j.sourceId}`} className="min-w-0 shrink truncate hover:underline" title={title(j)}>{title(j)}</Link>
                <span className="min-w-0 flex-1 truncate text-xs text-muted" title={j.error ?? undefined}>
                  {j.error}{j.attempts > 1 && <> {t("library.queue.triedTimes", { count: j.attempts })}</>}
                </span>
                {q.canManage && (
                  <Button type="button" size="sm" variant="ghost" className="shrink-0" disabled={busy === j.id}
                    aria-label={t("library.queue.retryLabel", { title: title(j) })} onClick={() => void act(j.id, `/api/jobs/${j.id}/retry`)}>
                    <RotateCw aria-hidden className={clsx("size-3.5", busy === j.id && "motion-safe:animate-spin")} />{t("library.queue.retry")}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {q.stalled > 0 && (
        <p className="mt-4 flex items-center gap-2 text-sm text-warn">
          <AlertTriangle aria-hidden className="size-4 shrink-0" />{t("library.queue.stalled", { count: q.stalled })}
        </p>
      )}

      {note && <p role="status" className={clsx("mt-3 text-sm", note.tone === "error" ? "text-danger" : "text-muted")}>{note.text}</p>}
    </section>
  );
}
