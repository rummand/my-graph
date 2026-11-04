"use client";
import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { KeyRound } from "lucide-react";
import { Badge, Button, Field, Input, Select } from "@/components/ui";
import { api, errorMessage } from "@/lib/auth/client/api";
import { ErrorNote } from "@/app/login/notes";
import { useT } from "@/lib/i18n/client";
import type { KeyOut } from "@/lib/mcp-server/keys";
import { useWhen } from "../../_components/use-when";
import { PanelFooter } from "../../_components/section";
import { CopyValue } from "./copy";

type GraphOption = { id: string; name: string; kind: string; canPropose: boolean };

/** Personal access keys: make one (shown once), see them, revoke one. */
export function KeysPanel({ initial, graphs, defaultGraphId, address }: { initial: KeyOut[]; graphs: GraphOption[]; defaultGraphId: string; address: string }) {
  const t = useT();
  const w = useWhen();
  const [keys, setKeys] = useState(initial);
  const [name, setName] = useState("");
  const [graphId, setGraphId] = useState(graphs.some((g) => g.id === defaultGraphId) ? defaultGraphId : graphs[0]?.id ?? "");
  const [scope, setScope] = useState<"read" | "propose">("read");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<string | null>(null);
  const graph = graphs.find((g) => g.id === graphId);
  const graphName = Object.fromEntries(graphs.map((g) => [g.id, g.name]));

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const r = await api<{ key: string; out: KeyOut }>("/api/mcp/keys", { json: { name, graphId, scope: graph?.canPropose ? scope : "read" } });
      setKeys((xs) => [r.out, ...xs]);
      setMade(r.key);
      setName("");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(k: KeyOut) {
    if (!window.confirm(t("mcpServer.keys.revokeConfirm", { name: k.name }))) return;
    setError(null);
    try {
      await api(`/api/mcp/keys/${k.id}`, { method: "DELETE" });
      setKeys((xs) => xs.filter((x) => x.id !== k.id));
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <div>
      <AnimatePresence initial={false}>
        {made && (
          <motion.div key="made" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }} className="mb-5 overflow-hidden">
            <div className="rounded-md bg-accent-tint p-4">
              <p className="font-medium">{t("mcpServer.keys.made")}</p>
              <p className="mt-0.5 text-sm text-muted">{t("mcpServer.keys.madeHint")}</p>
              <CopyValue className="mt-3" value={made} secret label={t("mcpServer.keys.made")} />
              <CopyValue className="mt-2" value={`claude mcp add --transport http my-graph ${address} --header "Authorization: Bearer ${made}"`} />
              <Button className="mt-3" variant="secondary" size="sm" onClick={() => setMade(null)}>{t("mcpServer.keys.done")}</Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {keys.length > 0 ? (
        <ul className="mb-5 divide-y divide-line">
          <AnimatePresence initial={false}>
            {keys.map((k) => (
              <motion.li key={k.id} layout exit={{ opacity: 0, height: 0 }} className="flex flex-wrap items-center gap-3 py-2.5">
                <KeyRound size={16} strokeWidth={1.75} aria-hidden className="shrink-0 text-muted" />
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="font-medium">{k.name}</span>
                    <code className="font-mono text-xs text-muted">{k.prefix}</code>
                    <Badge tone={k.scope === "propose" ? "accent" : "neutral"}>{k.scope === "propose" ? t("mcpServer.access.propose") : t("mcpServer.access.read")}</Badge>
                  </p>
                  <p className="mt-0.5 text-sm text-muted">
                    {t("mcpServer.graphOf", { graph: graphName[k.graphId] ?? "?" })}. {t("mcpServer.keys.created", { date: w.date(k.createdAt) })}.{" "}
                    {k.lastUsedAt ? t("mcpServer.apps.lastUsed", { ago: w.ago(k.lastUsedAt) }) : t("mcpServer.apps.neverUsed")}.
                  </p>
                </div>
                <Button variant="ghost" size="sm" onClick={() => revoke(k)}>{t("mcpServer.keys.revoke")}</Button>
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      ) : (
        <p className="mb-5 text-sm text-muted">{t("mcpServer.keys.empty")}</p>
      )}

      <form onSubmit={create} className="grid gap-4 border-t border-line pt-5 sm:grid-cols-2">
        <Field label={t("mcpServer.keys.name")}>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("mcpServer.keys.namePlaceholder")} maxLength={60} required />
        </Field>
        <Field label={t("mcpServer.keys.graph")}>
          <Select value={graphId} onChange={(e) => setGraphId(e.target.value)}>
            {graphs.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </Select>
        </Field>
        <fieldset className="sm:col-span-2">
          <legend className="mb-1.5 text-sm font-medium">{t("mcpServer.access.label")}</legend>
          <div className="flex flex-wrap gap-x-6 gap-y-2">
            {(["read", "propose"] as const).map((s) => {
              const off = s === "propose" && !graph?.canPropose;
              return (
                <label key={s} className={`flex items-center gap-2 text-sm ${off ? "text-muted" : ""}`}>
                  <input type="radio" name="key-scope" value={s} checked={(off ? "read" : scope) === s} disabled={off} onChange={() => setScope(s)} className="accent-accent" />
                  {t(`mcpServer.access.${s}`)}
                </label>
              );
            })}
          </div>
          {graph && !graph.canPropose && <p className="mt-1 text-xs text-muted">{t("mcpServer.access.proposeUnavailable")}</p>}
        </fieldset>
        <PanelFooter className="sm:col-span-2 mt-0" status={<ErrorNote message={error} />}>
          <Button type="submit" disabled={busy || !name.trim() || !graphId}>{busy ? t("mcpServer.keys.creating") : t("mcpServer.keys.create")}</Button>
        </PanelFooter>
      </form>
    </div>
  );
}
