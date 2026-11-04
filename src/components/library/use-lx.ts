"use client";
import { useMemo } from "react";
import { useLocale, useT, useTimeZone } from "@/lib/i18n/client";
import type { Lx } from "./i18n";

/** The library's translator, language and zone in a client component. `family`: family wording (family graph only). */
export function useLx(family: boolean): Lx {
  const t = useT(), locale = useLocale(), timeZone = useTimeZone();
  return useMemo(() => ({ t, locale, timeZone, family }), [t, locale, timeZone, family]);
}
