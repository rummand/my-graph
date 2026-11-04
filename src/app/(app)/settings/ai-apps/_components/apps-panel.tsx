"use client";
import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Bot } from "lucide-react";
import { Badge, Button } from "@/components/ui";
import { api, errorMessage } from "@/lib/auth/client/api";
import { ErrorNote } from "@/app/login/notes";
import { useT } from "@/lib/i18n/client";
import type { ConnectedApp } from "@/lib/mcp-server/oauth";
import { useWhen } from "../../_components/use-when";

/** The AI apps a person connected: what each is, where, what it may do, and Disconnect. */
export function AppsPanel({ initial, graphName }: { initial: ConnectedApp[]; graphName: Record<string, string> }) {
  const t = useT();
  const w = useWhen();
  const [apps, setApps] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function disconnect(a: ConnectedApp) {
    if (!window.confirm(t("mcpServer.apps.disconnectConfirm", { app: a.app }))) return;
    setBusy(a.id); setError(null);
    try {
      await api(`/api/mcp/apps/${encodeURIComponent(a.id)}`, { method: "DELETE" });
      setApps((xs) => xs.filter((x) => x.id !== a.id));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  if (!apps.length) return <p className="p-5 text-sm text-muted">{t("mcpServer.apps.empty")}</p>;
  return (
    <div className="px-5 py-1">
      <ErrorNote message={error} className="my-3" />
      <ul className="divide-y divide-line">
        <AnimatePresence initial={false}>
          {apps.map((a) => (
            <motion.li key={a.id} layout exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
              className="flex flex-wrap items-center gap-3 py-3">
              <Bot size={18} strokeWidth={1.75} aria-hidden className="shrink-0 text-muted" />
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="font-medium">{a.app}</span>
                  <Badge tone={a.scope === "propose" ? "accent" : "neutral"}>{a.scope === "propose" ? t("mcpServer.access.propose") : t("mcpServer.access.read")}</Badge>
                </p>
                <p className="mt-0.5 text-sm text-muted">
                  {t("mcpServer.graphOf", { graph: graphName[a.graphId] ?? "?" })}. {t("mcpServer.apps.returnsTo", { host: a.returnsTo })}.{" "}
                  {a.lastUsedAt ? t("mcpServer.apps.lastUsed", { ago: w.ago(a.lastUsedAt) }) : t("mcpServer.apps.neverUsed")}.
                </p>
              </div>
              <Button variant="secondary" size="sm" disabled={busy === a.id} onClick={() => disconnect(a)}>{t("mcpServer.apps.disconnect")}</Button>
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
    </div>
  );
}
