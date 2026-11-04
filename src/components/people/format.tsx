"use client";
import { useMemo } from "react";
import { useLocale, useT, useTimeZone } from "@/lib/i18n/client";
import { makeFmt, type Fmt } from "@/lib/people/fmt";

export { makeFmt, type Fmt } from "@/lib/people/fmt";

export function useFmt(): Fmt {
  const t = useT(), locale = useLocale(), timeZone = useTimeZone();
  return useMemo(() => makeFmt(t, locale, timeZone), [t, locale, timeZone]);
}

/** A date rendered in the viewer's timezone; server and client may disagree, so hydration warnings are suppressed. */
export function When({ iso, mode = "ago", className }: { iso: string | null; mode?: "ago" | "date"; className?: string }) {
  const f = useFmt();
  if (!iso) return <span className={className}>—</span>;
  return (
    <time dateTime={iso} title={f.full(iso)} className={className} suppressHydrationWarning>
      {mode === "ago" ? f.ago(iso) : f.shortDate(iso)}
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
