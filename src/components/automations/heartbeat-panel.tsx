"use client";
import { useMemo, useRef, useState } from "react";
import { Button, Select } from "@/components/ui";
import type { AutomationDTO } from "@/lib/automations/automations";
import { DEFAULT_TZ, previewRuns, safeParseTrigger, WEEKDAYS } from "@/lib/automations/schedule";
import { api, DaysPicker, Toggle, when, whenInline } from "./bits";
import { useRunNow } from "./run-now";

type Cfg = { everyMinutes: number; days: number[]; from: string; to: string; tz: string };

function initialCfg(h: AutomationDTO | null): Cfg {
  const c = (h?.config ?? {}) as Partial<Cfg>;
  return { everyMinutes: c.everyMinutes ?? 60, days: c.days ?? WEEKDAYS, from: c.from ?? "07:00", to: c.to ?? "20:00", tz: c.tz ?? DEFAULT_TZ };
}

/** Scout's Heartbeat: a check-in on chosen days and hours that only proposes. */
export function HeartbeatPanel({ initial, canCreate, cap, onOpenRun, onChanged }: {
  initial: AutomationDTO | null; canCreate: boolean; cap: number; onOpenRun: (id: string) => void; onChanged?: () => void;
}) {
  const [hb, setHb] = useState<AutomationDTO | null>(initial);
  const [cfg, setCfg] = useState<Cfg>(() => initialCfg(initial));
  const [enabled, setEnabled] = useState(initial?.enabled ?? false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const run = useRunNow(hb?.id ?? null, (r) => { onChanged?.(); if (r) setHb((h) => h && { ...h, lastRunAt: r.startedAt }); });

  const valid = useMemo(() => safeParseTrigger("heartbeat", cfg), [cfg]);
  const next = useMemo(() => (valid && enabled ? previewRuns(valid, new Date(), 1)[0] ?? null : null), [valid, enabled]);

  function save(patch: { enabled?: boolean; config?: Cfg }, delay = 0) {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      if (patch.config && !safeParseTrigger("heartbeat", patch.config)) return;
      setSaving(true); setError(null);
      try {
        const r = await api<{ heartbeat: AutomationDTO }>("/api/automations/heartbeat", { method: "PATCH", json: patch });
        setHb(r.heartbeat);
        onChanged?.();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Couldn't save.");
        if (patch.enabled !== undefined) setEnabled(!patch.enabled);
      } finally {
        setSaving(false);
      }
    }, delay);
  }
  const change = (c: Partial<Cfg>) => {
    const nc = { ...cfg, ...c };
    setCfg(nc);
    if (hb || enabled) save({ config: nc }, 500);
  };
  const toggle = (on: boolean) => {
    setEnabled(on);
    save({ enabled: on, config: cfg });
  };

  const hoursBad = cfg.from >= cfg.to;
  return (
    <div className="rounded-lg bg-surface p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="font-medium">Check in on its own</p>
          <p className="mt-0.5 text-sm text-muted">
            {enabled
              ? next ? `Next check-in ${whenInline(next)}.` : "No check-in times with these settings."
              : "Off. Switch it on to have the assistant look for what changed and what's coming."}
            {hb?.lastRunAt ? ` Last checked ${whenInline(hb.lastRunAt)}.` : ""}
          </p>
        </div>
        <Toggle checked={enabled} onChange={toggle} label="Check-ins" disabled={!canCreate || saving} />
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-[auto_1fr]">
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">How often</span>
          <Select value={cfg.everyMinutes} disabled={!canCreate} onChange={(e) => change({ everyMinutes: Number(e.target.value) })} className="w-40">
            <option value={15}>Every 15 minutes</option>
            <option value={30}>Every 30 minutes</option>
            <option value={60}>Every hour</option>
            <option value={120}>Every 2 hours</option>
          </Select>
        </label>
        <div>
          <span className="mb-1.5 block text-sm font-medium">Between</span>
          <div className="flex items-center gap-2">
            <input type="time" aria-label="From" value={cfg.from} disabled={!canCreate} onChange={(e) => change({ from: e.target.value })}
              className="h-9 rounded-md bg-surface px-2 text-[15px] tabular-nums ring-1 ring-inset ring-line focus:outline-none focus:ring-2 focus:ring-accent" />
            <span className="text-muted">and</span>
            <input type="time" aria-label="To" value={cfg.to} disabled={!canCreate} onChange={(e) => change({ to: e.target.value })}
              className="h-9 rounded-md bg-surface px-2 text-[15px] tabular-nums ring-1 ring-inset ring-line focus:outline-none focus:ring-2 focus:ring-accent" />
          </div>
          {hoursBad && <p className="mt-1.5 text-sm text-danger">The end has to be after the start.</p>}
        </div>
      </div>
      <div className="mt-4">
        <span className="mb-1.5 block text-sm font-medium">On these days</span>
        <DaysPicker value={cfg.days} disabled={!canCreate} onChange={(days) => days.length && change({ days })} />
      </div>

      <div className="mt-4 rounded-md bg-surface-2 px-3 py-2.5 text-sm">
        <p className="font-medium">Stricter when nobody is watching</p>
        <p className="mt-1 text-muted">
          A check-in looks at new files, reminders due in the next two days, overdue ones, birthdays this week, people you
          haven&apos;t been in touch with, and facts waiting to be checked. It only suggests: it never adds facts, shares
          anything, changes who can see something or messages anyone. Anything like that is skipped and listed in the run.
          Tentative plans count as busy. At most {cap} suggestion{cap === 1 ? "" : "s"} a day.
        </p>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        {hb && <Button size="sm" variant="secondary" onClick={run.start} disabled={!canCreate || run.busy}>{run.busy ? "Checking…" : "Check in now"}</Button>}
        {run.result && (
          <button className="text-left text-sm text-muted hover:text-fg" onClick={() => onOpenRun(run.result!.id)}>
            {run.result.summary ?? "Done."} <span className="text-accent">See the run</span>
          </button>
        )}
        {(error || run.error) && <span role="alert" className="text-sm text-danger">{error ?? run.error}</span>}
        {saving && <span className="text-sm text-muted">Saving…</span>}
      </div>
    </div>
  );
}
