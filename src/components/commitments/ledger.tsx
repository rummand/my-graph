"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { clsx } from "clsx";
import { ListChecks } from "lucide-react";
import { Avatar, Button, EmptyState, Tabs, buttonClass } from "@/components/ui";
import { useT } from "@/lib/i18n/client";
import { countLedger, filterPerson, filterTab, groupByUrgency, URGENCIES, type CommitmentView, type LedgerTab } from "@/lib/commitments/pure";
import type { CommitmentUrgency } from "@/lib/commitments/types";
import { act, ActError, fetchLedger, type Action, type LedgerData } from "./client";
import { CommitmentRow } from "./row";
import type { CommitmentFlag } from "@/lib/commitments/watch/flags";
import { useCommitmentActions } from "./assistant-actions";

const EASE = [0.22, 1, 0.36, 1] as const;

/** The header's one line: "3 this week, 1 at risk" (overdue first when there is any). */
export function HeaderLine({ counts, className }: { counts: ReturnType<typeof countLedger>; className?: string }) {
  const t = useT();
  if (!counts.thisWeek && !counts.atRisk && !counts.overdue) return <p className={clsx("text-muted", className)}>{t("commitments.header.nothing")}</p>;
  const parts: { text: string; tone?: "warn" | "danger" }[] = [];
  if (counts.overdue) parts.push({ text: t("commitments.header.overdue", { count: counts.overdue }), tone: "danger" });
  parts.push({ text: t("commitments.header.thisWeek", { count: counts.thisWeek }) });
  if (counts.atRisk) parts.push({ text: t("commitments.header.atRisk", { count: counts.atRisk }), tone: "warn" });
  return (
    <p className={clsx("text-[15px]", className)}>
      {parts.map((p, i) => (
        <span key={i} className={p.tone === "danger" ? "font-medium text-danger" : p.tone === "warn" ? "font-medium text-warn" : "text-fg"}>{i > 0 ? ", " : ""}{p.text}</span>
      ))}
    </p>
  );
}

/** The ledger: header line, waiting proposals, tabs and person filter, then sections by urgency. */
export function CommitmentsLedger({ initial, waiting, lead }: { initial: LedgerData; waiting?: ReactNode; lead: string }) {
  const t = useT();
  const [data, setData] = useState(initial);
  // The server sent a fresh ledger (a proposal was delivered above, router.refresh()): take it.
  useEffect(() => { setData(initial); }, [initial]);
  const [tab, setTab] = useState<LedgerTab>("all");
  const [person, setPerson] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; tone: "ok" | "warn" | "danger"; undo?: () => void } | null>(null);
  const now = useMemo(() => new Date(data.now), [data.now]);
  const tz = data.tz;

  const refresh = useCallback(async () => {
    try { setData(await fetchLedger()); } catch { /* keep what we have */ }
  }, []);

  const onAct = useCallback(async (c: CommitmentView, a: Action): Promise<boolean> => {
    setMsg(null);
    // Done collapses away at once; the server's answer settles it.
    if (a.action === "done") setData((d) => ({ ...d, items: d.items.map((x) => (x.id === c.id ? { ...x, props: { ...x.props, status: "done", doneAt: new Date().toISOString() } } : x)) }));
    try {
      const r = await act(c.id, a);
      if (r.status === "proposed") setMsg({ text: t("commitments.result.proposed"), tone: "warn" });
      else {
        const text = [t(`commitments.result.${a.action}`), r.nextProposalId ? t("commitments.result.next") : ""].filter(Boolean).join(" ");
        setMsg({ text, tone: "ok", undo: a.action === "done" || a.action === "cancel" ? () => void onAct({ ...c, props: { ...c.props, status: a.action === "done" ? "done" : "cancelled" } }, { action: "reopen" }) : undefined });
      }
      await refresh();
      return true;
    } catch (e) {
      setMsg({ text: e instanceof ActError && e.message ? e.message : t("commitments.result.failed"), tone: "danger" });
      await refresh();
      return false;
    }
  }, [refresh, t]);

  const byPerson = filterPerson(data.items, person);
  const shown = filterTab(byPerson, tab);
  const groups = groupByUrgency(shown, now, tz);
  const counts = countLedger(data.items, now, tz);
  const tabCount = (x: LedgerTab) => filterTab(byPerson, x).length;
  const nobodyHas = data.items.length === 0;

  useCommitmentActions({ items: data.items, shown, everyone: data.everyone, canWrite: data.canWrite, now, tz, tab, setTab, person, setPerson, onAct });

  const rowProps = { now, tz, everyone: data.everyone, canWrite: data.canWrite, onAct };
  const flagsOf = (id: string) => data.flags?.[id];

  return (
    <div>
      <header className="mb-6 flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <div className="min-w-0">
          <h1 className="text-[28px]/[1.15] font-semibold tracking-[-0.02em]">{t("commitments.title")}</h1>
          <HeaderLine counts={counts} className="mt-2" />
        </div>
        {counts.open > 0 && <p className="text-sm tabular-nums text-muted">{t("commitments.header.open", { count: counts.open })}</p>}
      </header>
      <p className="-mt-3 mb-7 max-w-[62ch] text-sm text-muted">{lead}</p>

      <div role="status" aria-live="polite" className="min-h-0">
        <AnimatePresence>
          {msg && (
            <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.18, ease: EASE }}
              className={clsx("mb-5 flex flex-wrap items-center gap-3 rounded-lg px-4 py-2.5 text-sm",
                msg.tone === "ok" ? "bg-surface" : msg.tone === "warn" ? "bg-warn-tint text-warn" : "bg-danger-tint text-danger")}>
              <span className="min-w-0 flex-1">{msg.text}</span>
              {msg.undo && <button type="button" className="font-medium text-accent hover:underline" onClick={() => { const u = msg.undo!; setMsg(null); u(); }}>{t("commitments.result.undo")}</button>}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className={clsx("grid gap-x-10 gap-y-9", waiting && "lg:grid-cols-[minmax(0,1fr)_340px]")}>
      {/* On phones, decisions waiting for you come first; on desktop they sit beside the list. */}
      {waiting && <aside className="min-w-0 lg:order-last">{waiting}</aside>}
      <div className="min-w-0">
      {nobodyHas ? (
        <EmptyState icon={<ListChecks className="size-6" />} title={t("commitments.empty.title")}
          action={data.canWrite ? <Link href="/library" className={buttonClass("secondary")}>{t("commitments.empty.action")}</Link> : undefined}>
          {t("commitments.empty.body")}
        </EmptyState>
      ) : (
        <>
          <div className="mb-6 flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
            <div className="max-w-full overflow-x-auto">
              <Tabs value={tab} onSelect={setTab} items={(["all", "owe", "owed", "promise", "done"] as LedgerTab[]).map((x) => ({
                value: x, label: <>{t(`commitments.tabs.${x}`)}{x !== "done" && tabCount(x) > 0 && <span className="text-xs tabular-nums text-muted">{tabCount(x)}</span>}</>,
              }))} />
            </div>
            {data.people.length > 0 && (
              <div role="group" aria-label={t("commitments.people.label")} className="flex flex-wrap items-center gap-1.5">
                <button type="button" aria-pressed={!person} onClick={() => setPerson(null)}
                  className={clsx("h-8 rounded-full px-3 text-sm transition-colors", !person ? "bg-fg text-bg" : "bg-surface-2 text-muted hover:text-fg")}>
                  {t("commitments.people.everyone")}
                </button>
                {data.people.map((p) => (
                  <button key={p.id} type="button" aria-pressed={person === p.id} onClick={() => setPerson(person === p.id ? null : p.id)}
                    title={t("commitments.people.only", { name: p.label })} aria-label={t("commitments.people.only", { name: p.label })}
                    className={clsx("rounded-full p-0.5 transition-[box-shadow,opacity]", person === p.id ? "ring-2 ring-fg" : person ? "opacity-50 hover:opacity-100" : "hover:ring-2 hover:ring-line")}>
                    <Avatar id={p.id} name={p.label} size={28} />
                  </button>
                ))}
              </div>
            )}
          </div>

          {tab === "done" ? (
            shown.length
              ? <ul className="divide-y divide-line/70 rounded-lg bg-surface">{shown.map((c) => <CommitmentRow key={c.id} c={c} {...rowProps} flags={flagsOf(c.id)} />)}</ul>
              : <EmptyState title={t("commitments.empty.done")} />
          ) : shown.length === 0 ? (
            <EmptyState title={t("commitments.empty.filtered")} action={<Button variant="secondary" onClick={() => { setTab("all"); setPerson(null); }}>{t("commitments.empty.clear")}</Button>} />
          ) : (
            <div className="space-y-9">
              {URGENCIES.filter((u) => groups[u].length).map((u) => <UrgencySection key={u} u={u} items={groups[u]} rowProps={rowProps} flags={data.flags ?? {}} />)}
            </div>
          )}
        </>
      )}
      </div>
      </div>
    </div>
  );
}

function UrgencySection({ u, items, rowProps, flags }: { u: CommitmentUrgency; items: CommitmentView[]; flags: Record<string, CommitmentFlag[]>; rowProps: Omit<Parameters<typeof CommitmentRow>[0], "c"> }) {
  const t = useT();
  const id = `sec-${u}`;
  const hint = u === "overdue" || u === "at_risk" || u === "undated" ? t(`commitments.sectionHint.${u}`) : null;
  return (
    <section aria-labelledby={id} className="min-w-0">
      <div className="mb-2.5 flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <h2 id={id} className={clsx("text-lg font-semibold tracking-[-0.01em]", u === "overdue" && "text-danger", u === "at_risk" && "text-warn")}>
          {t(`commitments.section.${u}`)} <span className="ml-1 text-sm font-normal tabular-nums text-muted">{items.length}</span>
        </h2>
        {hint && <p className="text-sm text-muted">{hint}</p>}
      </div>
      <ul className="divide-y divide-line/70 rounded-lg bg-surface">
        <AnimatePresence initial={false}>
          {items.map((c) => <CommitmentRow key={c.id} c={c} {...rowProps} flags={flags[c.id]} />)}
        </AnimatePresence>
      </ul>
    </section>
  );
}
