"use client";
/** PHQ-9 and GAD-7: an entry form (scored on the server) and each instrument's trend. */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { clsx } from "clsx";
import { Plus } from "lucide-react";
import { Button, Field, Input, Tabs } from "@/components/ui";
import { useFormatDate, useT } from "@/lib/i18n/client";
import { INSTRUMENTS, type Instrument } from "@/lib/clinical/pure";
import type { ItemView } from "@/lib/clinical/items";
import { call } from "./api";
import { TrendChart } from "./trend-chart";

export function Measures({ clientId, items, canWrite, allowed }: { clientId: string; items: ItemView[]; canWrite: boolean; allowed: boolean }) {
  const t = useT();
  const fmt = useFormatDate();
  const [open, setOpen] = useState(false);
  const measures = items.filter((i) => i.kind === "measure" && i.status === "confirmed" && i.value != null);
  const by = (k: Instrument) => measures.filter((m) => m.content.instrument === k);
  return (
    <div className="space-y-4">
      {measures.length === 0 && !open && <p className="text-sm text-muted">{t("clinical.measures.none")}</p>}
      <div className="grid gap-6 sm:grid-cols-2">
        {(Object.keys(INSTRUMENTS) as Instrument[]).map((k) => by(k).length > 0 && (
          <div key={k}>
            <p className="mb-1 text-sm font-medium">{t("clinical.measures.trend", { label: INSTRUMENTS[k].label })}</p>
            <TrendChart label={INSTRUMENTS[k].label} min={0} max={INSTRUMENTS[k].max} points={by(k).map((m) => ({ at: m.measuredAt ?? m.createdAt, value: m.value! }))} />
            <ul className="mt-2 space-y-0.5 text-sm">
              {by(k).slice(0, 5).map((m) => (
                <li key={m.id} className="flex justify-between gap-2 tabular-nums">
                  <span className="text-muted">{fmt(m.measuredAt ?? m.createdAt)}</span>
                  <span>{m.value} <span className="text-muted">({t(`clinical.measures.band.${String(m.content.band)}`)})</span></span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      {canWrite && allowed && !open && <Button size="sm" variant="secondary" onClick={() => setOpen(true)}><Plus aria-hidden className="size-4" />{t("clinical.measures.add")}</Button>}
      {open && <MeasureForm clientId={clientId} onDone={() => setOpen(false)} />}
    </div>
  );
}

function MeasureForm({ clientId, onDone }: { clientId: string; onDone: () => void }) {
  const t = useT();
  const router = useRouter();
  const [inst, setInst] = useState<Instrument>("phq9");
  const [answers, setAnswers] = useState<(number | null)[]>(Array(9).fill(null));
  const [takenAt, setTakenAt] = useState(new Date().toISOString().slice(0, 10));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const n = INSTRUMENTS[inst].items;
  const list = answers.slice(0, n);
  const score = list.every((a) => a !== null) ? list.reduce<number>((s, a) => s + (a ?? 0), 0) : null;
  return (
    <form className="space-y-4 rounded-lg bg-surface p-4" onSubmit={async (e) => {
      e.preventDefault();
      setBusy(true); setError(null);
      const r = await call(`/api/clinical/clients/${clientId}/measures`, { body: { instrument: inst, answers: list, takenAt } }, t("clinical.err.offline"));
      setBusy(false);
      if (r.error) { setError(r.error); return; }
      onDone(); router.refresh();
    }}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <Tabs value={inst} onSelect={(v) => { setInst(v); setAnswers(Array(9).fill(null)); }} items={[{ value: "phq9", label: t("clinical.measures.phq9") }, { value: "gad7", label: t("clinical.measures.gad7") }]} />
        <Field label={t("clinical.measures.takenAt")} className="w-44"><Input type="date" value={takenAt} onChange={(e) => setTakenAt(e.target.value)} /></Field>
      </div>
      <p className="text-sm text-muted">{t("clinical.measures.lead")}</p>
      <ol className="space-y-3">
        {list.map((a, i) => (
          <li key={`${inst}-${i}`}>
            <fieldset>
              <legend className={clsx("text-sm", inst === "phq9" && i === 8 && "font-medium text-danger")}>{i + 1}. {t(`clinical.measures.q.${inst}.${i + 1}`)}</legend>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {[0, 1, 2, 3].map((v) => (
                  <label key={v} className={clsx("cursor-pointer rounded-md px-2.5 py-1 text-sm", a === v ? "bg-fg text-bg" : "bg-surface-2 text-muted hover:text-fg")}>
                    <input type="radio" className="sr-only" name={`${inst}-${i}`} checked={a === v} onChange={() => setAnswers(answers.map((x, j) => (j === i ? v : x)))} />
                    {v} {t(`clinical.measures.answers.${v}`)}
                  </label>
                ))}
              </div>
            </fieldset>
          </li>
        ))}
      </ol>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={busy || score === null}>{t("clinical.measures.save")}</Button>
        <Button type="button" variant="ghost" onClick={onDone}>{t("clinical.consent.cancel")}</Button>
        {score !== null && <span className="text-sm font-medium tabular-nums">{t("clinical.measures.score", { score })}</span>}
      </div>
    </form>
  );
}
