"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui";

/** Restore an old version, with a one-step confirmation in place (no browser dialog). */
export function RestoreButton({ slug, revisionId, revisionVersion, pageVersion }: { slug: string; revisionId: string; revisionVersion: number; pageVersion: number }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const restore = async () => {
    setBusy(true); setError(null);
    try {
      const res = await fetch(`/api/wiki/${encodeURIComponent(slug)}/restore`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ revisionId, version: pageVersion }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 409) throw new Error("Someone edited the page a moment ago. The history is up to date now; check the latest version and try again.");
      if (!res.ok) throw new Error(data.error ?? "Couldn't restore this version.");
      router.push(`/wiki/${encodeURIComponent(slug)}`);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't restore this version.");
      setBusy(false);
      setConfirming(false);
      router.refresh();
    }
  };
  return (
    <div className="flex flex-col items-start gap-2 sm:items-end">
      {confirming ? (
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label={`Restore version ${revisionVersion}?`}>
          <span className="text-sm text-muted">Make this the current text?</span>
          <Button size="sm" onClick={() => void restore()} disabled={busy}>{busy ? "Restoring…" : `Restore version ${revisionVersion}`}</Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirming(false)} disabled={busy}>Cancel</Button>
        </div>
      ) : (
        <Button size="sm" variant="secondary" onClick={() => setConfirming(true)}><RotateCcw aria-hidden className="size-3.5" />Restore this version</Button>
      )}
      {error && <p role="alert" className="max-w-sm text-sm text-danger">{error}</p>}
    </div>
  );
}
