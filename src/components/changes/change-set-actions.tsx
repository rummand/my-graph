"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useT } from "@/lib/i18n/client";
import { Button, buttonClass } from "@/components/ui";

/**
 * Deliver all / Drop / Review for a proposal shown in a list (Today, a library item). Delivering sends the fingerprint
 * the list was rendered with, so a proposal that changed since is refused and the person is sent to review it.
 */
export function ChangeSetActions({ id, fingerprint, canDeliver, hasConflicts }: { id: string; fingerprint: string | null; canDeliver: boolean; hasConflicts: boolean }) {
  const t = useT();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const post = async (path: string, body: unknown) => {
    setBusy(true); setMsg(null);
    const res = await fetch(`/api/changes/${id}/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (res.ok) { router.refresh(); return; }
    if (data.stale || data.conflicts?.length) { router.push(`/changes/${id}`); return; }
    setMsg(data.error ?? t("changes.failed"));
  };
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      {canDeliver && !hasConflicts && (
        <Button size="sm" disabled={busy} onClick={() => post("deliver", { fingerprint: fingerprint ?? undefined })}>
          {busy ? t("changes.delivering") : t("changes.deliverAll")}
        </Button>
      )}
      <Link href={`/changes/${id}`} className={buttonClass(canDeliver && !hasConflicts ? "secondary" : "primary", "sm")}>{t("changes.review")}</Link>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => { if (window.confirm(t("changes.dropConfirm"))) void post("abandon", {}); }}>{t("changes.drop")}</Button>
      {msg && <p role="status" className="text-sm text-danger">{msg}</p>}
    </div>
  );
}
