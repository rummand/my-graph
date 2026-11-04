"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Archive } from "lucide-react";
import { useT } from "@/lib/i18n/client";
import { Button } from "@/components/ui";

/**
 * On a retired node's page: it is out of lists, search and the graph, but still here by id. "Restore as a proposal"
 * opens a change set that brings it back; a person delivers it like any other.
 */
export function RetiredNotice({ nodeId, retiredOn, canPropose }: { nodeId: string; retiredOn: string | null; canPropose: boolean }) {
  const t = useT();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const restore = async () => {
    setBusy(true); setError(null);
    const res = await fetch("/api/changes/restore-node", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ nodeId }) });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (res.ok && data.changeSetId) { router.push(`/changes/${data.changeSetId}`); return; }
    setError(data.error ?? t("changes.failed"));
  };
  return (
    <div role="note" className="mb-8 flex flex-wrap items-start gap-x-4 gap-y-3 rounded-lg bg-warn-tint px-4 py-3 text-sm">
      <Archive aria-hidden className="mt-0.5 size-4 shrink-0 text-warn" />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-warn">{retiredOn ? t("changes.retired.titleOn", { date: retiredOn }) : t("changes.retired.title")}</p>
        <p className="mt-0.5 max-w-[65ch] text-fg/85">{t("changes.retired.body")}</p>
        {error && <p role="status" className="mt-1 text-danger">{error}</p>}
      </div>
      {canPropose && <Button size="sm" variant="secondary" disabled={busy} onClick={restore}>{busy ? t("changes.retired.restoring") : t("changes.retired.restore")}</Button>}
    </div>
  );
}
