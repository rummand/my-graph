"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useT } from "@/lib/i18n/client";
import { Button } from "@/components/ui";

type Ready = { id: string; fingerprint: string | null; changes: number; connected: number };

/**
 * "Deliver all ready" on /changes: every proposal in the list where nothing needs a person, after a confirm with the
 * counts. Each goes with the fingerprint it was shown with, so one that changed in the meantime is kept back.
 */
export function DeliverReady({ sets }: { sets: Ready[] }) {
  const t = useT();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  if (!sets.length) return null;
  const changes = sets.reduce((n, s) => n + s.changes, 0);
  const connected = sets.reduce((n, s) => n + s.connected, 0);
  const run = async () => {
    if (!window.confirm(t("changes.bulk.confirm", { count: sets.length, changes, connected }))) return;
    setBusy(true); setMsg(null);
    const res = await fetch("/api/changes/deliver-ready", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sets: sets.map((s) => ({ id: s.id, fingerprint: s.fingerprint })) }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setMsg({ ok: false, text: data.error ?? t("changes.failed") }); return; }
    const parts = [t("changes.bulk.done", { count: data.delivered?.length ?? 0 })];
    if (data.kept?.length) parts.push(t("changes.bulk.kept", { count: data.kept.length }));
    setMsg({ ok: !data.kept?.length, text: parts.join(" ") });
    router.refresh();
  };
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button size="sm" disabled={busy} onClick={run}>{busy ? t("changes.bulk.delivering") : t("changes.bulk.deliverReady", { count: sets.length })}</Button>
      {msg && <p role="status" className={msg.ok ? "text-sm text-accent" : "text-sm text-warn"}>{msg.text}</p>}
    </div>
  );
}
