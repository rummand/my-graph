"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui";

export function RestoreButton({ slug, revisionId, revisionVersion, pageVersion }: { slug: string; revisionId: string; revisionVersion: number; pageVersion: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const restore = async () => {
    if (!window.confirm(`Restore version ${revisionVersion}? The current text is kept in the history.`)) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch(`/api/wiki/${encodeURIComponent(slug)}/restore`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ revisionId, version: pageVersion }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 409) throw new Error("Someone edited the page a moment ago. The history has been refreshed — check the latest version and try again.");
      if (!res.ok) throw new Error(data.error ?? "Couldn't restore this version.");
      router.push(`/wiki/${encodeURIComponent(slug)}`);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't restore this version.");
      setBusy(false);
      router.refresh();
    }
  };
  return (
    <div className="flex flex-col items-start gap-1">
      <Button variant="secondary" onClick={() => void restore()} disabled={busy}><RotateCcw aria-hidden className="size-4" />{busy ? "Restoring…" : "Restore this version"}</Button>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    </div>
  );
}
