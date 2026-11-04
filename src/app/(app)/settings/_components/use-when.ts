"use client";
import { useMemo } from "react";
import { dayKey } from "@/lib/i18n/dates";
import { formatAgo, useFormatDate, useLocale, useT, useTimeZone } from "@/lib/i18n/client";

/** Dates for settings lists in the reader's language and zone: "3 Nov", "5 minutes ago", "today" / "on 3 Nov". */
export function useWhen() {
  const t = useT();
  const locale = useLocale();
  const tz = useTimeZone();
  const fmt = useFormatDate();
  return useMemo(() => ({
    date: (iso: string) => fmt(iso, "date"),
    ago: (iso: string) => formatAgo(iso, locale),
    when: (iso: string) => {
      const d = dayKey(iso, tz);
      const today = dayKey(new Date(), tz);
      const yesterday = dayKey(new Date(Date.now() - 86_400_000), tz);
      return d === today ? t("settings.when.today") : d === yesterday ? t("settings.when.yesterday") : t("settings.when.on", { date: fmt(iso, "date") });
    },
  }), [t, locale, tz, fmt]);
}
