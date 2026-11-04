"use client";
import { clsx } from "clsx";
import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { CopyVariant } from "@/components/memory/variant";
import type { ParsedTrigger } from "@/lib/automations/schedule";
import { useFormatDate, useLocale, useT, useTimeZone } from "@/lib/i18n/client";
import { agoText, triggerText, whenText, type Copy } from "./describe";

/** fetch JSON from our API; throws an Error with the server's plain message. */
export async function api<T>(url: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(url, {
    ...rest,
    headers: { ...(json !== undefined ? { "content-type": "application/json" } : {}), ...(rest.headers ?? {}) },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(body.error ?? "That didn't go through. Try again.");
  return body as T;
}

/**
 * The reader's wording for times and states: `when` ("Today 18:00"), `whenInline` ("today 18:00"), `ago`, `status`,
 * `trigger` (a schedule in words), plus `t` and the graph's copy variant (family wording only in a family graph).
 */
/** "family" only inside a family graph; set once by the Automations page. */
export const VariantContext = createContext<CopyVariant>("other");

export function useCopy() {
  const t = useT();
  const vr = useContext(VariantContext);
  const fmt = useFormatDate();
  const timeZone = useTimeZone();
  const locale = useLocale();
  return useMemo(() => {
    const c: Copy = { t, fmt, timeZone, locale };
    return {
      t,
      vr,
      /** t() of a key that has `.family` / `.other` variants. */
      tv: (key: string, vars?: Record<string, string | number>) => t(`${key}.${vr}`, vars),
      when: (iso: string | Date | null | undefined) => whenText(c, iso),
      whenInline: (iso: string | Date | null | undefined) => whenText(c, iso, true),
      ago: (iso: string | Date) => agoText(c, iso),
      status: (s: string) => t(`automations.status.${s === "failed" || s === "running" || s === "skipped" ? s : "done"}`),
      trigger: (p: ParsedTrigger) => triggerText(c, p),
    };
  }, [t, vr, fmt, timeZone, locale]);
}

export function Toggle({ checked, onChange, label, disabled, className }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean; className?: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} title={label} disabled={disabled}
      onClick={() => onChange(!checked)}
      className={clsx("relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-45",
        checked ? "bg-fg" : "bg-line", className)}>
      <span className={clsx("inline-block size-4 rounded-full bg-bg shadow-[0_1px_2px_rgb(0_0_0/0.15)] transition-transform duration-150 ease-out", checked ? "translate-x-[18px]" : "translate-x-0.5")} />
    </button>
  );
}

/** Monday-first day chips (Danish week). */
const ORDER = [1, 2, 3, 4, 5, 6, 0];
export function DaysPicker({ value, onChange, disabled }: { value: number[]; onChange: (d: number[]) => void; disabled?: boolean }) {
  const t = useT();
  return (
    <div className="flex flex-wrap gap-1" role="group" aria-label={t("automations.days.label")}>
      {ORDER.map((d) => {
        const on = value.includes(d);
        return (
          <button key={d} type="button" aria-pressed={on} disabled={disabled}
            onClick={() => onChange(on ? value.filter((x) => x !== d) : [...value, d].sort())}
            className={clsx("h-8 min-w-11 rounded-md px-2 text-sm transition-colors disabled:opacity-45",
              on ? "bg-fg font-medium text-bg" : "bg-surface-2 text-muted hover:text-fg")}>
            {t(`automations.days.short.d${d}`)}
          </button>
        );
      })}
    </div>
  );
}

export function StatusDot({ status }: { status: string }) {
  const cls = status === "failed" ? "bg-danger" : status === "running" ? "bg-accent" : status === "skipped" ? "bg-muted/50" : "bg-fg/70";
  return <span aria-hidden className={clsx("inline-block size-1.5 shrink-0 rounded-full", cls)} />;
}

export function Hint({ children }: { children: ReactNode }) {
  return <p className="text-sm text-muted">{children}</p>;
}
