"use client";
import { useCallback, useEffect, useState } from "react";
import { Download, Trash2 } from "lucide-react";
import { Button, IconButton, Select, buttonClass } from "@/components/ui";
import { useFormatDate, useLocale, useT } from "@/lib/i18n/client";
import { api, errorMessage } from "@/lib/auth/client/api";
import { formatBytes } from "@/components/admin/format";
import { ErrorNote } from "@/app/login/notes";
import { PanelFooter } from "./section";

export type ExportItem = {
  id: string; scope: string; graphId: string | null; status: string; progress: { step: string; done?: number; total?: number } | null;
  error: string | null; createdAt: string; expiresAt: string | null; bytes: number | null; downloadUrl: string | null;
};

/** Settings > Your data > Download a copy: pick what, make it in the background, download it for 24 hours. */
export function DataExport({ ownedGraphs, initial }: { ownedGraphs: { id: string; name: string }[]; initial: ExportItem[] }) {
  const t = useT();
  const fmt = useFormatDate();
  const locale = useLocale();
  const [what, setWhat] = useState<"account" | "graph">("account");
  const [graphId, setGraphId] = useState(ownedGraphs[0]?.id ?? "");
  const [items, setItems] = useState<ExportItem[]>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const live = items.some((x) => x.status === "queued" || x.status === "running");

  const refresh = useCallback(async () => {
    try {
      const r = await api<{ exports: ExportItem[] }>("/api/export");
      setItems(r.exports);
    } catch { /* keep what we have; the next poll tries again */ }
  }, []);

  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => void refresh(), 2500);
    return () => clearInterval(id);
  }, [live, refresh]);

  async function make(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api("/api/export", { json: what === "graph" ? { scope: "graph", graphId } : { scope: "account" } });
      await refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setError(null);
    try {
      await api(`/api/export/${id}`, { method: "DELETE" });
      setItems((xs) => xs.filter((x) => x.id !== id));
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const graphName = (id: string | null) => ownedGraphs.find((g) => g.id === id)?.name;
  const status = (x: ExportItem) => {
    if (x.status === "ready" && x.downloadUrl) return t("settings.data.statusReady", { size: formatBytes(x.bytes ?? 0, locale) });
    if (x.status === "ready" || x.status === "expired") return t("settings.data.statusExpired");
    if (x.status === "failed") return t("settings.data.statusFailed", { error: x.error ?? "" });
    if (x.status === "running" && x.progress?.step === "zipping") return t("settings.data.statusZipping");
    if (x.status === "running" && x.progress?.total) return t("settings.data.statusRunning", { done: (x.progress.done ?? 0) + 1, total: x.progress.total });
    return t("settings.data.statusQueued");
  };

  return (
    <div>
      <form onSubmit={make}>
        <fieldset>
          <legend className="sr-only">{t("settings.data.exportTitle")}</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="flex cursor-pointer gap-3 rounded-md bg-surface-2 p-3 has-[:checked]:ring-2 has-[:checked]:ring-accent">
              <input type="radio" name="export-what" value="account" checked={what === "account"} onChange={() => setWhat("account")} className="mt-1 accent-[var(--accent)]" />
              <span className="min-w-0">
                <span className="block font-medium">{t("settings.data.whatAccount")}</span>
                <span className="block text-sm text-muted">{t("settings.data.whatAccountHint")}</span>
              </span>
            </label>
            <label className={`flex gap-3 rounded-md bg-surface-2 p-3 has-[:checked]:ring-2 has-[:checked]:ring-accent ${ownedGraphs.length ? "cursor-pointer" : "opacity-60"}`}>
              <input type="radio" name="export-what" value="graph" checked={what === "graph"} disabled={!ownedGraphs.length} onChange={() => setWhat("graph")} className="mt-1 accent-[var(--accent)]" />
              <span className="min-w-0">
                <span className="block font-medium">{t("settings.data.whatGraph")}</span>
                <span className="block text-sm text-muted">{ownedGraphs.length ? t("settings.data.whatGraphHint") : t("settings.data.noOwnedGraphs")}</span>
              </span>
            </label>
          </div>
        </fieldset>
        {what === "graph" && ownedGraphs.length > 0 && (
          <div className="mt-4 max-w-xs">
            <label htmlFor="export-graph" className="mb-1.5 block text-sm font-medium">{t("settings.data.pickGraph")}</label>
            <Select id="export-graph" value={graphId} onChange={(e) => setGraphId(e.target.value)}>
              {ownedGraphs.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </Select>
          </div>
        )}
        <ErrorNote message={error} className="mt-4" />
        <PanelFooter status={<p className="text-sm text-muted">{t("settings.data.exportHint")}</p>}>
          <Button type="submit" variant="secondary" disabled={busy || live}>
            <Download size={16} aria-hidden />{busy ? t("settings.data.making") : t("settings.data.export")}
          </Button>
        </PanelFooter>
      </form>

      {items.length > 0 && (
        <div className="mt-5 border-t border-line pt-4">
          <h3 className="text-sm font-medium text-muted">{t("settings.data.recent")}</h3>
          <ul className="mt-2 divide-y divide-line" aria-live="polite">
            {items.map((x) => (
              <li key={x.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">
                    {x.scope === "graph" ? t("settings.data.scopeGraph", { name: graphName(x.graphId) ?? t("settings.data.scopeGraphGone") }) : t("settings.data.scopeAccount")}
                    <span className="ml-2 text-sm font-normal text-muted tabular-nums">{fmt(x.createdAt, "dateTime")}</span>
                  </p>
                  <p className={`text-sm ${x.status === "failed" ? "text-danger" : "text-muted"}`}>
                    {status(x)}
                    {x.downloadUrl && x.expiresAt && <> · {t("settings.data.availableUntil", { time: fmt(x.expiresAt, "dateTime") })}</>}
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  {x.downloadUrl && (
                    <a href={x.downloadUrl} download className={buttonClass("secondary", "sm")}>
                      <Download size={14} aria-hidden />{t("settings.data.download")}
                    </a>
                  )}
                  {x.status !== "queued" && x.status !== "running" && (
                    <IconButton label={t("settings.data.removeLabel")} onClick={() => void remove(x.id)}>
                      <Trash2 size={16} aria-hidden />
                    </IconButton>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
