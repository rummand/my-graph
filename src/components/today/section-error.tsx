"use client";
import { clsx } from "clsx";
import { useT } from "@/lib/i18n/client";

/** Shown when one part of the page couldn't load; the rest of the page keeps working. `what` is already translated. */
export function SectionError({ what, className }: { what: string; className?: string }) {
  const t = useT();
  return (
    <p role="status" className={clsx("rounded-lg bg-warn-tint px-3 py-2.5 text-sm text-warn", className)}>
      <span className="font-medium">{t("today.error.couldntLoad", { what })}</span> {t("today.error.restWorks")}
    </p>
  );
}
