"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui";
import { useT } from "@/lib/i18n/client";

/** Restore an old version, with a one-step confirmation in place (no browser dialog). */
export function RestoreButton({ slug, revisionId, revisionVersion, pageVersion }: { slug: string; revisionId: string; revisionVersion: number; pageVersion: number }) {
  const router = useRouter();
  const t = useT();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const restore = async () => {
    setBusy(true); setError(null);
    try {
      const res = await fetch(`/api/pages/${encodeURIComponent(slug)}/restore`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ revisionId, version: pageVersion }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 409) throw new Error(t("pages.restore.conflict"));
      if (!res.ok) throw new Error(data.error ?? t("pages.restore.failed"));
      router.push(`/artifacts/pages/${encodeURIComponent(slug)}`);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("pages.restore.failed"));
      setBusy(false);
      setConfirming(false);
      router.refresh();
    }
  };
  return (
    <div className="flex flex-col items-start gap-2 sm:items-end">
      {confirming ? (
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t("pages.restore.confirmGroup", { n: revisionVersion })}>
          <span className="text-sm text-muted">{t("pages.restore.confirm")}</span>
          <Button size="sm" onClick={() => void restore()} disabled={busy}>{busy ? t("pages.restore.restoring") : t("pages.restore.restoreN", { n: revisionVersion })}</Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirming(false)} disabled={busy}>{t("pages.restore.cancel")}</Button>
        </div>
      ) : (
        <Button size="sm" variant="secondary" onClick={() => setConfirming(true)}><RotateCcw aria-hidden className="size-3.5" />{t("pages.restore.button")}</Button>
      )}
      {error && <p role="alert" className="max-w-sm text-sm text-danger">{error}</p>}
    </div>
  );
}
