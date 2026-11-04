"use client";
import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ChevronDown, RefreshCw } from "lucide-react";
import { clsx } from "clsx";
import { Button } from "@/components/ui";
import type { KeeperStatus } from "@/lib/keeper";
import { MentionText } from "@/components/mention";
import { fromMarkup } from "@/lib/mentions/markup";

const plain = (x: string) => fromMarkup(x).text;
import { formatAgo, useLocale, useT } from "@/lib/i18n/client";

const EASE = [0.22, 1, 0.36, 1] as const;

/** "What the Brain Keeper did": its latest runs for you in this graph, every change with why and where it came from. */
export function KeeperReport({ canRun }: { canRun: boolean }) {
  const t = useT();
  const locale = useLocale();
  const ago = (iso: string | null) => {
    if (!iso) return "";
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "" : formatAgo(d, locale);
  };
  const [status, setStatus] = useState<KeeperStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/keeper", { cache: "no-store" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof body.error === "string" ? body.error : t("memory.keeper.loadError"));
      setStatus(body as KeeperStatus);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("memory.keeper.loadError"));
    }
  }, [t]);

  useEffect(() => { void load(); }, [load]);

  // While a run is going, check back every few seconds.
  const busy = status?.busy ?? false;
  useEffect(() => {
    if (!busy) return;
    const t = window.setInterval(() => void load(), 4000);
    return () => window.clearInterval(t);
  }, [busy, load]);

  async function runNow() {
    setStarting(true); setError(null);
    try {
      const res = await fetch("/api/keeper", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "run" }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok && res.status !== 409) throw new Error(typeof body.error === "string" ? body.error : t("memory.keeper.startError"));
      await new Promise((r) => setTimeout(r, 600));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("memory.keeper.startError"));
    } finally {
      setStarting(false);
    }
  }

  const runs = status?.runs ?? [];
  const latest = runs[0];
  const shown = runs.filter((r) => r.status !== "skipped").slice(0, 5);

  return (
    <section aria-labelledby="keeper-heading" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 id="keeper-heading" className="text-lg font-semibold">{t("memory.keeper.heading")}</h2>
          <p className="text-sm text-muted">
            {busy ? t("memory.keeper.running")
              : status?.lastFinishedAt ? <span suppressHydrationWarning>{t("memory.keeper.lastRan", { time: ago(status.lastFinishedAt) })}</span>
                : t("memory.keeper.intro")}
            {status && status.waiting > 0 && !busy && <> <span className="text-warn">{t("memory.keeper.waiting", { count: status.waiting })}</span></>}
          </p>
        </div>
        {canRun && (
          <Button size="sm" variant="secondary" onClick={() => void runNow()} disabled={starting || busy}>
            <RefreshCw aria-hidden className={clsx("size-4", (starting || busy) && "motion-safe:animate-spin")} />
            {busy ? t("memory.keeper.runningButton") : starting ? t("memory.keeper.starting") : t("memory.keeper.runNow")}
          </Button>
        )}
      </div>

      {error && <p role="alert" className="text-sm text-danger">{error}</p>}

      {status && !shown.length && !busy && (
        <p className="text-sm text-muted">{t("memory.keeper.empty")}</p>
      )}

      {shown.length > 0 && (
        <ol className="space-y-2">
          {shown.map((r) => {
            const expanded = open === r.id || (open === null && r.id === latest?.id && r.actions.length > 0 && r.actions.length <= 6);
            return (
              <li key={r.id} className="rounded-lg bg-surface px-4 py-3">
                <button type="button" className="flex w-full items-start gap-3 text-left" aria-expanded={expanded}
                  onClick={() => setOpen(expanded ? "" : r.id)}>
                  <span className="min-w-0 flex-1">
                    <span className={clsx("block text-[15px]", r.status === "failed" && "text-danger")}>{r.headline}</span>
                    <span className="mt-0.5 block text-xs text-muted">
                      {ago(r.finishedAt ?? r.startedAt)}{r.trigger === "person" ? t("memory.keeper.whenAsked") : ""}
                      {r.model ? t("memory.keeper.onModel", { model: r.model }) : r.status === "done" && r.actions.length ? t("memory.keeper.withoutModel") : ""}
                    </span>
                  </span>
                  {(r.actions.length > 0 || r.report || r.error) && (
                    <ChevronDown aria-hidden className={clsx("mt-1 size-4 shrink-0 text-muted transition-transform", expanded && "rotate-180")} />
                  )}
                </button>
                <AnimatePresence initial={false}>
                  {expanded && (
                    <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
                      transition={{ duration: 0.2, ease: EASE }} className="overflow-hidden">
                      {r.actions.length > 0 && (
                        <ul className="mt-3 divide-y divide-line">
                          {r.actions.map((a, i) => (
                            <li key={`${r.id}:${i}`} className="py-2.5 text-sm">
                              <p>
                                <span className={clsx("font-medium", a.op === "declined" && "text-muted")}>{t(`memory.keeper.verb.${a.op}`)}</span>{" "}
                                {a.href ? <a href={a.href} className="hover:text-accent hover:underline">&ldquo;{plain(a.text)}&rdquo;</a> : <span>&ldquo;<MentionText text={a.text} />&rdquo;</span>}
                                {a.status === "pending" && <span className="text-warn">{t("memory.keeper.waitingForYou")}</span>}
                              </p>
                              {a.op === "updated" && a.before?.[0] && a.before[0] !== a.text && <p className="mt-0.5 text-xs text-muted line-through decoration-muted/50">{plain(a.before[0])}</p>}
                              {a.op === "merged" && a.before && a.before.length > 1 && (
                                <p className="mt-0.5 text-xs text-muted">{t("memory.keeper.fromMemories", { count: a.before.length, list: a.before.slice(1).map((b) => `“${plain(b)}”`).join(", ") })}</p>
                              )}
                              <p className="mt-0.5 text-muted">{a.why}</p>
                              {a.links.length > 0 && (
                                <p className="mt-0.5 text-xs text-muted">
                                  {t("memory.keeper.from")} {a.links.map((l, j) => (
                                    <span key={`${l.type}:${l.id}`}>{j > 0 && ", "}<a href={l.href} className="text-accent hover:underline">{l.title}</a></span>
                                  ))}
                                </p>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                      {r.report && r.report !== r.headline && <p className="mt-3 whitespace-pre-line text-sm text-muted">{r.report}</p>}
                      {r.error && <p className="mt-3 text-sm text-danger">{r.error}</p>}
                    </motion.div>
                  )}
                </AnimatePresence>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
