"use client";
/** "Open my practice": makes the practice graph the first time and switches to it. */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Stethoscope } from "lucide-react";
import { Button, EmptyState } from "@/components/ui";
import { useT } from "@/lib/i18n/client";
import { call } from "./api";

export function PracticeStart() {
  const t = useT();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <EmptyState icon={<Stethoscope className="size-6" aria-hidden />} title={t("clinical.start.title")}
      action={<div className="flex flex-col items-center gap-2">
        <Button disabled={busy} onClick={async () => {
          setBusy(true); setError(null);
          const r = await call("/api/clinical/practice", { body: {} }, t("clinical.err.offline"));
          setBusy(false);
          if (r.error) setError(r.error); else router.refresh();
        }}>{busy ? t("clinical.start.opening") : t("clinical.start.action")}</Button>
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      </div>}>
      {t("clinical.start.lead")}
    </EmptyState>
  );
}
