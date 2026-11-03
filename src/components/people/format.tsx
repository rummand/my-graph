"use client";
import { differenceInCalendarDays, format, formatDistanceToNowStrict } from "date-fns";

/** "today", "yesterday", "5 days ago", "3 months ago" — calendar-aware for the recent past. */
export function ago(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return "never";
  const d = new Date(iso);
  const days = differenceInCalendarDays(now, d);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  return `${formatDistanceToNowStrict(d)} ago`;
}

/** "Mon 16 Nov", with the year added when it isn't this year: "Mon 16 Nov 2025". */
export function shortDate(iso: string, now = new Date()): string {
  const d = new Date(iso);
  return format(d, d.getFullYear() === now.getFullYear() ? "EEE d MMM" : "EEE d MMM yyyy");
}

/** "16 Nov" / "16 Nov 2025": compact, for date columns. */
export function compactDate(iso: string, now = new Date()): string {
  const d = new Date(iso);
  return format(d, d.getFullYear() === now.getFullYear() ? "d MMM" : "d MMM yyyy");
}

/** "75 days", "4 weeks", "3 months": a span of days in words. */
export function daysWords(n: number): string {
  if (n < 21) return `${n} day${n === 1 ? "" : "s"}`;
  if (n < 60) return `${Math.round(n / 7)} weeks`;
  return `${Math.round(n / 30)} months`;
}

/** "Sun 8 Nov" for a local YYYY-MM-DD. */
export function dayLabel(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return format(new Date(y, m - 1, d), "EEE d MMM");
}

export function inDays(n: number): string {
  return n === 0 ? "today" : n === 1 ? "tomorrow" : `in ${n} days`;
}

/** A date rendered in the viewer's timezone; server and client may disagree, so hydration warnings are suppressed. */
export function When({ iso, mode = "ago", className }: { iso: string | null; mode?: "ago" | "date"; className?: string }) {
  if (!iso) return <span className={className}>—</span>;
  return (
    <time dateTime={iso} title={format(new Date(iso), "PPPp")} className={className} suppressHydrationWarning>
      {mode === "ago" ? ago(iso) : shortDate(iso)}
    </time>
  );
}

export async function api<T>(url: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error((data as { error?: string }).error ?? `Request failed (${res.status})`), { status: res.status, data });
  return data as T;
}

export type FieldErrors = Record<string, string>;
/** Field errors from an API error (`{ fields: [{ key, message }] }`). */
export function fieldErrors(e: unknown): FieldErrors {
  const fields = (e as { data?: { fields?: { key: string; message: string }[] } })?.data?.fields ?? [];
  return Object.fromEntries(fields.map((f) => [f.key, f.message]));
}
