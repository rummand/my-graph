"use client";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useLocale } from "@/lib/i18n/client";
import { makeWhen, type When } from "./when";

/** Timeline date formatting in the reader's language. */
export function useWhen(): When {
  const locale = useLocale();
  return useMemo(() => makeWhen(locale), [locale]);
}

/** Live media-query match; `fallback` during SSR. */
export function useMediaQuery(query: string, fallback = false): boolean {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia(query);
      m.addEventListener("change", cb);
      return () => m.removeEventListener("change", cb);
    },
    () => window.matchMedia(query).matches,
    () => fallback,
  );
}

export const usePrefersReducedMotion = () => useMediaQuery("(prefers-reduced-motion: reduce)");

/** Element width, tracked with a ResizeObserver. */
export function useWidth<T extends HTMLElement>(el: T | null): number {
  const [w, setW] = useState(0);
  useEffect(() => {
    if (!el) return;
    setW(el.clientWidth);
    const ro = new ResizeObserver((entries) => setW(Math.round(entries[0].contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return w;
}

/** "Now", refreshed every minute so the Today line moves. */
export function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
