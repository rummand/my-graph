"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { clsx } from "clsx";
import { LOCALE_NAMES, LOCALES, type Locale } from "@/lib/i18n/core";
import { useLocale, useT } from "@/lib/i18n/client";

/** English / Dansk on the signed-out pages. Remembered in a cookie until you sign in and choose in Settings. */
export function LanguageSwitch({ className }: { className?: string }) {
  const router = useRouter();
  const t = useT();
  const current = useLocale();
  const [busy, setBusy] = useState(false);

  async function choose(l: Locale) {
    if (l === current || busy) return;
    setBusy(true);
    try {
      await fetch("/api/settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ locale: l }) });
      document.documentElement.lang = l;
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div role="group" aria-label={t("auth.frame.language")} className={clsx("flex items-center gap-1 text-sm", className)}>
      {LOCALES.map((l) => (
        <button key={l} type="button" lang={l} aria-pressed={l === current} disabled={busy} onClick={() => void choose(l)}
          className={clsx("rounded-md px-2 py-1 transition-colors", l === current ? "font-medium text-fg" : "text-muted hover:bg-surface-2 hover:text-fg")}>
          {LOCALE_NAMES[l]}
        </button>
      ))}
    </div>
  );
}
