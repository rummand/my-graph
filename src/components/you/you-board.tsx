"use client";
import Link from "next/link";
import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Lock, RefreshCw } from "lucide-react";
import { Button, EmptyState, PageHeader, Section } from "@/components/ui";
import { Switch } from "@/components/onboarding/switch";
import { formatAgo, useFormatDate, useLocale, useT } from "@/lib/i18n/client";
import type { InsightView, SignalView, YouView } from "@/lib/you/types";
import { InsightChart, Spark } from "./charts";

const EASE = [0.22, 1, 0.36, 1] as const;

async function call(url: string, method: string, body?: unknown): Promise<{ ok: boolean; data: unknown }> {
  const r = await fetch(url, { method, headers: body ? { "content-type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  return { ok: r.ok, data: await r.json().catch(() => null) };
}

export function YouBoard({ initial, graphName }: { initial: YouView; graphName: string }) {
  const t = useT();
  const locale = useLocale();
  const [view, setView] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const save = async (patch: Partial<Pick<YouView, "enabled" | "mood" | "combine">>) => {
    if (patch.enabled === false && !window.confirm(t("you.settings.offConfirm"))) return;
    setBusy("settings"); setMsg(null);
    const r = await call("/api/you", "PUT", patch);
    setBusy(null);
    if (r.ok) { setView(r.data as YouView); setMsg(t("you.settings.saved")); } else setMsg(t("you.settings.failed"));
  };
  const refresh = async () => {
    setBusy("refresh"); setMsg(null);
    const r = await call("/api/you/refresh", "POST");
    setBusy(null);
    if (r.ok) { setView(r.data as YouView); setMsg(t("you.refreshed")); } else setMsg((r.data as { error?: string } | null)?.error ?? t("you.refreshFailed"));
  };

  if (view.status === "not_allowed") {
    return (<><PageHeader title={t("you.title")} /><EmptyState title={t("you.notAllowed.title")}>{t("you.notAllowed.body")}</EmptyState></>);
  }

  const privacy = (
    <span className="mt-3 flex max-w-[70ch] items-start gap-2 text-sm text-muted">
      <Lock className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span><span className="font-medium text-fg">{t("you.privacy.title")}.</span> {t("you.privacy.body")} {view.combine ? t("you.privacy.combined") : t("you.privacy.graph", { graph: graphName })}</span>
    </span>
  );

  const settings = (
    <Section title={t("you.settings.title")} id="you-settings">
      <div className="divide-y divide-line rounded-lg bg-surface">
        <SettingRow label={t("you.settings.enabled")} hint={t("you.settings.enabledHint")} checked={view.enabled} busy={busy === "settings"} onChange={(x) => save({ enabled: x })} />
        {view.enabled && <SettingRow label={t("you.settings.mood")} hint={t("you.settings.moodHint")} checked={view.mood} busy={busy === "settings"} onChange={(x) => save({ mood: x })} />}
        {view.enabled && <SettingRow label={t("you.settings.combine")} hint={t("you.settings.combineHint")} checked={view.combine} busy={busy === "settings"} onChange={(x) => save({ combine: x })} />}
      </div>
    </Section>
  );

  if (!view.enabled) {
    return (
      <>
        <PageHeader title={t("you.title")} lead={t("you.lead")} />
        <EmptyState title={t("you.off.title")} action={<Button onClick={() => save({ enabled: true })} disabled={busy !== null}>{t("you.off.turnOn")}</Button>}>
          <p>{t("you.off.body")}</p>
          {view.child && <p className="mt-2">{t("you.off.child")}</p>}
        </EmptyState>
        {privacy}
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={t("you.title")}
        lead={<>{t("you.lead")}{privacy}</>}
        actions={
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted" aria-live="polite">{msg ?? (view.computedAt ? t("you.updated", { when: formatAgo(view.computedAt, locale) }) : t("you.never"))}</span>
            <Button variant="secondary" size="sm" onClick={refresh} disabled={busy !== null}>
              <RefreshCw className={busy === "refresh" ? "size-4 animate-spin motion-reduce:animate-none" : "size-4"} aria-hidden />
              {busy === "refresh" ? t("you.refreshing") : t("you.refresh")}
            </Button>
          </div>
        }
      />
      <div className="grid gap-10 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-10">
          <Section title={t("you.insights")} id="you-insights">
            {view.insights.length ? (
              <>
                <p className="-mt-1 mb-3 text-sm text-muted">{t("you.insightsHint")}</p>
                <ul className="space-y-3">
                  <AnimatePresence initial={false}>
                    {view.insights.map((i) => (
                      <motion.li key={i.id} layout exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.2, ease: EASE }}>
                        <Insight insight={i} onHidden={() => setView((v) => ({ ...v, insights: v.insights.filter((x) => x.id !== i.id) }))} />
                      </motion.li>
                    ))}
                  </AnimatePresence>
                </ul>
              </>
            ) : (
              <EmptyState title={t("you.empty.title")}>{t("you.empty.body")}</EmptyState>
            )}
          </Section>
        </div>
        <div className="min-w-0 space-y-10">
          <Signals signals={view.signals} />
          {settings}
        </div>
      </div>
    </>
  );
}

function SettingRow({ label, hint, checked, busy, onChange }: { label: string; hint: string; checked: boolean; busy: boolean; onChange: (x: boolean) => void }) {
  return (
    <div className="flex items-start justify-between gap-4 p-4">
      <div className="min-w-0">
        <p className="text-[15px] font-medium">{label}</p>
        <p className="mt-0.5 text-sm text-muted">{hint}</p>
      </div>
      <Switch checked={checked} onChange={onChange} label={label} busy={busy} disabled={busy} />
    </div>
  );
}

function Insight({ insight: i, onHidden }: { insight: InsightView; onHidden: () => void }) {
  const t = useT();
  const fmt = useFormatDate();
  const [feedback, setFeedback] = useState(i.feedback);
  const [said, setSaid] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [ideaOpen, setIdeaOpen] = useState(false);
  const [idea, setIdea] = useState<"idle" | "busy" | "added" | "failed">("idle");

  const answer = async (a: "yes" | "no" | "hide") => {
    const r = await call(`/api/you/insights/${i.id}`, "POST", { answer: a });
    if (!r.ok) return;
    if (a === "hide") { onHidden(); return; }
    setFeedback(a);
    setSaid(a === "yes" ? t("you.thanksYes") : t("you.thanksNo"));
  };
  const addIdea = async () => {
    setIdea("busy");
    const r = await call(`/api/you/insights/${i.id}/idea`, "POST");
    setIdea(r.ok ? "added" : "failed");
  };
  const chartLabels = {
    ring: t("you.chart.ring"), pair: t("you.chart.pair", { a: i.other ? t(`you.signal.${i.other}`) : "", b: t(`you.signal.${i.signal}`) }), bars: t("you.chart.bars"), spark: t("you.chart.spark"),
    barA: t("you.receipt.weeksLike", { count: i.receipts.counts.find((c) => c.key === "weeksLike")?.n ?? 0 }),
    barB: t("you.receipt.weeksOther", { count: i.receipts.counts.find((c) => c.key === "weeksOther")?.n ?? 0 }),
  };

  return (
    <article className="rounded-lg bg-surface p-4 sm:p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="min-w-0">
          <p className="text-[17px]/[1.35] font-medium tracking-[-0.01em]">{i.sentence}</p>
          <p className="mt-1 text-sm text-muted">{i.strength}{!i.current && <> {t("you.stale")}.</>}</p>
          {i.note && <p className="mt-1 text-xs text-muted">{i.note}</p>}
        </div>
        <div className="shrink-0"><InsightChart chart={i.chart} labels={chartLabels} /></div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        <button type="button" className="text-accent underline-offset-2 hover:underline" aria-expanded={open} onClick={() => setOpen((x) => !x)}>
          {t("you.basedOn")} {open ? "−" : "+"}
        </button>
        {i.idea && (
          <button type="button" className="text-muted underline-offset-2 hover:text-fg hover:underline" aria-expanded={ideaOpen} onClick={() => setIdeaOpen((x) => !x)}>
            {t("you.ideas")}
          </button>
        )}
        <span className="ml-auto flex items-center gap-1" role="group" aria-label={t("you.question")}>
          {said ? <span className="text-muted" aria-live="polite">{said}</span> : (
            <>
              <span className="mr-1 text-muted">{t("you.question")}</span>
              <FeedbackButton active={feedback === "yes"} onClick={() => answer("yes")}>{t("you.yes")}</FeedbackButton>
              <FeedbackButton active={feedback === "no"} onClick={() => answer("no")}>{t("you.no")}</FeedbackButton>
              <FeedbackButton onClick={() => answer("hide")}>{t("you.hide")}</FeedbackButton>
            </>
          )}
        </span>
      </div>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div key="receipts" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2, ease: EASE }} className="overflow-hidden">
            <div className="mt-3 border-t border-line pt-3 text-sm">
              <p className="text-muted">{i.receipts.counts.map((c) => t(`you.receipt.${c.key}`, { count: c.n })).join(", ")}.</p>
              {i.receipts.weeks.length > 0 && (
                <ul className="mt-2 flex flex-wrap gap-1.5">
                  {i.receipts.weeks.map((w) => (
                    <li key={w.week} className="rounded-full bg-surface-2 px-2 py-0.5 text-xs tabular-nums text-muted">{t("you.openWeek", { date: fmt(w.week, "date") })}: {w.value}</li>
                  ))}
                </ul>
              )}
              {i.receipts.links.length > 0 ? (
                <ul className="mt-2 space-y-1">
                  {i.receipts.links.map((l) => (
                    <li key={l.href}><Link href={l.href} className="text-accent underline-offset-2 hover:underline">{l.title}</Link></li>
                  ))}
                </ul>
              ) : <p className="mt-2 text-xs text-muted">{t("you.noLinks")}</p>}
            </div>
          </motion.div>
        )}
        {ideaOpen && i.idea && (
          <motion.div key="idea" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2, ease: EASE }} className="overflow-hidden">
            <div className="mt-3 flex flex-wrap items-center gap-3 rounded-md bg-surface-2/70 p-3 text-sm">
              <span>{i.idea.text}</span>
              {idea === "added" ? (
                <span className="text-muted">{t("you.ideaAdded")} <Link href="/automations" className="text-accent underline-offset-2 hover:underline">{t("you.ideaOpen")}</Link></span>
              ) : (
                <Button size="sm" variant="secondary" onClick={addIdea} disabled={idea === "busy"}>{t("you.ideaAdd")}</Button>
              )}
              {idea === "failed" && <span className="text-danger">{t("you.ideaFailed")}</span>}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </article>
  );
}

function FeedbackButton({ active, onClick, children }: { active?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" aria-pressed={active} onClick={onClick}
      className={active ? "rounded-md bg-surface-2 px-2 py-1 font-medium text-fg" : "rounded-md px-2 py-1 text-muted hover:bg-surface-2 hover:text-fg"}>
      {children}
    </button>
  );
}

function Signals({ signals }: { signals: SignalView[] }) {
  const t = useT();
  const locale = useLocale();
  const shown = signals.filter((s) => s.total > 0);
  return (
    <Section title={t("you.signals")} id="you-signals">
      <p className="-mt-1 mb-3 text-sm text-muted">{t("you.signalsHint")}</p>
      {shown.length ? (
        <ul className="divide-y divide-line rounded-lg bg-surface">
          {shown.map((s) => {
            const nums = s.recent.filter((v): v is number => v !== null);
            const avg = nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
            return (
              <li key={s.key} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{t(`you.signal.${s.key}`)}</p>
                  <p className="text-xs text-muted">{s.key === "mood" ? t("you.moodWeeks", { count: nums.length }) : t("you.perWeek", { value: new Intl.NumberFormat(locale === "da" ? "da-DK" : "en-GB", { maximumFractionDigits: 1, minimumFractionDigits: 1 }).format(avg) })}</p>
                </div>
                <Spark values={s.recent} label={t(`you.signal.${s.key}`)} />
              </li>
            );
          })}
        </ul>
      ) : <p className="text-sm text-muted">{t("you.noData")}</p>}
    </Section>
  );
}
