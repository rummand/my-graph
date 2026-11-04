"use client";
import { clsx } from "clsx";
import { format, isToday, isTomorrow, isYesterday, differenceInMinutes } from "date-fns";
import type { ReactNode } from "react";
import { DAY_SHORT } from "@/lib/automations/schedule";

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

/** "Today 18:00", "Tomorrow 07:00", "Yesterday 21:15", "Sun 8 Nov, 18:00". */
export function when(iso: string | Date | null | undefined): string {
  if (!iso) return "";
  const d = typeof iso === "string" ? new Date(iso) : iso;
  const t = format(d, "HH:mm");
  if (isToday(d)) return `Today ${t}`;
  if (isTomorrow(d)) return `Tomorrow ${t}`;
  if (isYesterday(d)) return `Yesterday ${t}`;
  return format(d, "EEE d MMM, HH:mm");
}

/** when() for the middle of a sentence: "today 18:00", "Sun 8 Nov, 18:00". */
export function whenInline(iso: string | Date | null | undefined): string {
  return when(iso).replace(/^(Today|Tomorrow|Yesterday)/, (m) => m.toLowerCase());
}

/** "just now", "12 min ago", or `when()` for anything older than an hour. */
export function ago(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  const m = differenceInMinutes(new Date(), d);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  return when(d);
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
  return (
    <div className="flex flex-wrap gap-1" role="group" aria-label="Days">
      {ORDER.map((d) => {
        const on = value.includes(d);
        return (
          <button key={d} type="button" aria-pressed={on} disabled={disabled}
            onClick={() => onChange(on ? value.filter((x) => x !== d) : [...value, d].sort())}
            className={clsx("h-8 min-w-11 rounded-md px-2 text-sm transition-colors disabled:opacity-45",
              on ? "bg-fg font-medium text-bg" : "bg-surface-2 text-muted hover:text-fg")}>
            {DAY_SHORT[d]}
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

export function statusLabel(s: string): string {
  return s === "failed" ? "Failed" : s === "running" ? "Running" : s === "skipped" ? "Nothing to do" : "Done";
}

export function Hint({ children }: { children: ReactNode }) {
  return <p className="text-sm text-muted">{children}</p>;
}
