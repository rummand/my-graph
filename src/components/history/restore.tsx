"use client";
import Link from "next/link";
import { useState } from "react";
import { useT } from "@/lib/i18n/client";
import { Button, Input } from "@/components/ui";

/** "Restore … as a proposal": asks the server to propose going back; the proposal opens for review. Nothing changes yet. */
export function RestoreButton({ url, body, label, variant = "secondary" }: { url: string; body: Record<string, unknown>; label: string; variant?: "primary" | "secondary" | "ghost" }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<{ id: string | null; error?: string } | null>(null);
  const go = async () => {
    setBusy(true); setOut(null);
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    setOut(res.ok ? { id: data.changeSetId ?? null } : { id: null, error: data.error ?? t("history.checkpoints.failed") });
  };
  return (
    <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
      <Button size="sm" variant={variant} disabled={busy} onClick={go}>{busy ? t("history.checkpoints.restoring") : label}</Button>
      {out?.error && <span role="status" className="text-sm text-danger">{out.error}</span>}
      {out && !out.error && !out.id && <span role="status" className="text-sm text-muted">{t("history.checkpoints.nothingToRestore")}</span>}
      {out?.id && (
        <span role="status" className="text-sm">
          {t("history.checkpoints.proposed")} <Link href={`/changes/${out.id}`} className="text-accent hover:underline">{t("history.checkpoints.open")}</Link>
        </span>
      )}
    </span>
  );
}

/** Name the current moment (a checkpoint). */
export function CheckpointForm() {
  const t = useT();
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!label.trim()) return;
    setBusy(true); setError(null);
    const res = await fetch("/api/checkpoints", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ label }) });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (res.ok) { setLabel(""); window.location.reload(); } else setError(data.error ?? t("history.checkpoints.failed"));
  };
  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
      <label className="min-w-0 flex-1 basis-56">
        <span className="mb-1 block text-sm text-muted">{t("history.checkpoints.label")}</span>
        <Input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={120} placeholder={t("history.checkpoints.placeholder")} />
      </label>
      <Button type="submit" size="md" variant="secondary" disabled={busy || !label.trim()}>{t("history.checkpoints.add")}</Button>
      {error && <p role="status" className="w-full text-sm text-danger">{error}</p>}
    </form>
  );
}
