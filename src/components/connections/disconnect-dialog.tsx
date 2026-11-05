"use client";
import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { clsx } from "clsx";
import { Button } from "@/components/ui";
import { useT } from "@/lib/i18n/client";
import type { ConnectionDTO, Revocation } from "@/lib/connectors";
import { api } from "./bits";

/** Disconnect, asking whether to keep what the connection brought in. */
export function DisconnectDialog({ connection, onClose, onDone }: {
  connection: ConnectionDTO | null; onClose: () => void; onDone: (message: string) => void;
}) {
  const t = useT();
  const [keep, setKeep] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [imported, setImported] = useState<number | null>(null);
  // After disconnecting, when the provider couldn't take the access back itself: what the person can still do.
  const [after, setAfter] = useState<{ done: string; note: string } | null>(null);

  useEffect(() => {
    if (!connection) return;
    setKeep(true); setError(null); setImported(null); setAfter(null);
    let live = true;
    api<{ imported: number }>(`/api/connections/${connection.id}`).then((d) => live && setImported(d.imported)).catch(() => live && setImported(connection.counts.total));
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => { live = false; window.removeEventListener("keydown", onKey); };
  }, [connection, onClose]);

  async function confirm() {
    if (!connection) return;
    setBusy(true); setError(null);
    try {
      const r = await api<{ removed: number; revocation?: Revocation }>(`/api/connections/${connection.id}?keep=${keep}`, { method: "DELETE" });
      const done = keep ? t("connections.disconnectDialog.kept") : t("connections.disconnectDialog.removed", { count: r.removed });
      const rv = r.revocation;
      const note = rv && rv.code !== "none" ? t(`security.revoke.${rv.code}`, rv.params, rv.message) : "";
      if (rv && rv.code !== "none" && rv.code !== "revoked") setAfter({ done, note });
      else onDone(note ? `${done} ${note}` : done);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("connections.errors.generic"));
    } finally {
      setBusy(false);
    }
  }

  const n = imported ?? connection?.counts.total ?? 0;
  return (
    <AnimatePresence>
      {connection && (
        <>
          <motion.div key="scrim" className="fixed inset-0 z-40 bg-fg/20" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }} onClick={onClose} />
          <motion.div key="dialog" role="dialog" aria-modal="true" aria-labelledby="disconnect-title"
            className="fixed inset-x-4 top-[15vh] z-50 mx-auto max-w-md rounded-lg bg-bg p-5 shadow-float"
            initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }} transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}>
            <h2 id="disconnect-title" className="text-lg font-semibold">{t("connections.disconnectDialog.title", { label: connection.label })}</h2>
            <p className="mt-1.5 text-sm text-muted">{n > 0 ? t("connections.disconnectDialog.body", { count: n }) : t("connections.disconnectDialog.bodyNone")}</p>
            {n > 0 && (
              <fieldset className="mt-4 space-y-2">
                {([true, false] as const).map((k) => (
                  <label key={String(k)} className={clsx("flex cursor-pointer gap-3 rounded-md px-3 py-2.5 ring-1 ring-inset transition-colors", keep === k ? "bg-surface ring-fg/40" : "ring-line hover:bg-surface-2")}>
                    <input type="radio" name="keep" className="mt-1 accent-[var(--color-fg)]" checked={keep === k} onChange={() => setKeep(k)} />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium">{t(k ? "connections.disconnectDialog.keep" : "connections.disconnectDialog.remove")}</span>
                      <span className="block text-sm text-muted">{t(k ? "connections.disconnectDialog.keepHint" : "connections.disconnectDialog.removeHint")}</span>
                    </span>
                  </label>
                ))}
              </fieldset>
            )}
            {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
            {after ? (
              <>
                <p role="status" className="mt-4 rounded-md bg-surface px-3 py-2.5 text-sm [overflow-wrap:anywhere]">{after.note}</p>
                <div className="mt-5 flex justify-end gap-2">
                  <Button onClick={() => onDone(after.done)}>{t("connections.disconnectDialog.ok")}</Button>
                </div>
              </>
            ) : (
              <div className="mt-5 flex justify-end gap-2">
                <Button variant="ghost" onClick={onClose} disabled={busy}>{t("connections.cancel")}</Button>
                <Button variant="danger" onClick={confirm} disabled={busy}>{t("connections.disconnectDialog.confirm")}</Button>
              </div>
            )}
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
