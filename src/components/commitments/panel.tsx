"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AnimatePresence } from "motion/react";
import { Badge, CitationChip } from "@/components/ui";
import { useLocale, useT, useTimeZone } from "@/lib/i18n/client";
import { formatAmount, leadDaysOf, urgencyOf, type CommitmentView, type Party } from "@/lib/commitments/pure";
import { act, ActError, type Action } from "./client";
import { CommitmentRow } from "./row";
import { recurrenceWords } from "./words";

/** The commitment part of a commitment's own page (/node/<id>): what, when, whose, from where, and the actions. */
export function CommitmentPanel({ id }: { id: string }) {
  const t = useT();
  const locale = useLocale();
  const tz = useTimeZone();
  const [state, setState] = useState<{ c: CommitmentView; everyone: Party[]; canWrite: boolean } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/commitments/${id}`, { cache: "no-store" });
    if (!res.ok) return;
    const d = await res.json();
    setState({ c: d.commitment, everyone: d.everyone ?? [], canWrite: !!d.canWrite });
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  const onAct = useCallback(async (_c: CommitmentView, a: Action) => {
    setMsg(null);
    try {
      const r = await act(id, a);
      setMsg(r.status === "proposed" ? t("commitments.result.proposed") : [t(`commitments.result.${a.action}`), r.nextProposalId ? t("commitments.result.next") : ""].filter(Boolean).join(" "));
      await load();
      return true;
    } catch (e) {
      setMsg(e instanceof ActError && e.message ? e.message : t("commitments.result.failed"));
      return false;
    }
  }, [id, load, t]);

  if (!state) return <div className="mb-10 h-24 animate-pulse rounded-lg bg-surface" aria-hidden />;
  const { c } = state;
  const now = new Date();
  const u = urgencyOf(c.props, now, tz);
  const rec = recurrenceWords(c.props.recurrence, t);
  return (
    <section aria-labelledby="commitment-h" className="mb-10 space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="commitment-h" className="sr-only">{t("commitments.detail.title")}</h2>
        <Badge tone={c.props.status !== "open" ? "neutral" : u === "overdue" ? "danger" : u === "at_risk" ? "warn" : "accent"}>
          {c.props.status === "open" && u ? t(`commitments.section.${u}`) : t(`commitments.status.${c.props.status}`)}
        </Badge>
        <span className="text-sm text-muted">{t(`commitments.direction.${c.props.direction}`)}, {t(`commitments.kind.${c.props.kind}`).toLowerCase()}</span>
        <Link href="/commitments" className="ml-auto text-sm text-accent hover:underline">{t("commitments.detail.back")}</Link>
      </div>
      <ul><AnimatePresence initial={false}><CommitmentRow c={c} now={now} tz={tz} everyone={state.everyone} canWrite={state.canWrite} onAct={onAct} card /></AnimatePresence></ul>
      {msg && <p role="status" className="text-sm text-muted">{msg}</p>}
      <dl className="grid gap-x-8 gap-y-3 text-sm sm:grid-cols-[max-content_minmax(0,1fr)]">
        {c.counterparty.length > 0 && <><dt className="text-muted">{t("commitments.detail.with")}</dt><dd>{c.counterparty.map((p) => <Link key={p.id} href={p.type === "person" ? `/people/${p.id}` : `/node/${p.id}`} className="mr-3 text-accent hover:underline">{p.label}</Link>)}</dd></>}
        {c.props.amount && <><dt className="text-muted">{t("commitments.detail.amount")}</dt><dd>{formatAmount(c.props.amount, locale)}</dd></>}
        {c.props.consequence && <><dt className="text-muted">{t("commitments.detail.consequence")}</dt><dd>{c.props.consequence}</dd></>}
        {rec && <><dt className="text-muted">{t("commitments.detail.repeats")}</dt><dd>{rec}</dd></>}
        {c.props.status === "open" && c.props.dueAt && <><dt className="text-muted">{t("commitments.detail.reminder")}</dt><dd>{t("commitments.detail.leadDays", { count: leadDaysOf(c.props) })}</dd></>}
        <dt className="text-muted">{t("commitments.detail.from")}</dt>
        <dd className="space-y-2">
          {c.sources.length === 0 && c.arisesFrom.length === 0 && <span className="text-muted">{t("commitments.detail.noSource")}</span>}
          {c.sources.map((s) => (
            <div key={`${s.sourceId}:${s.chunkId}`} className="space-y-1">
              <CitationChip title={s.title} href={s.href} detail={s.page ? `p. ${s.page}` : undefined} />
              {s.quote && <p className="max-w-[60ch] font-read italic text-fg/90">{t("commitments.detail.quote", { quote: s.quote })}</p>}
            </div>
          ))}
          {c.arisesFrom.filter((a) => !c.sources.some((s) => s.title === a.label)).map((a) => (
            <Link key={a.id} href={`/node/${a.id}`} className="mr-3 text-accent hover:underline">{a.label}</Link>
          ))}
        </dd>
      </dl>
    </section>
  );
}
