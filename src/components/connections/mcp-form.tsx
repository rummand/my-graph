"use client";
/**
 * Connecting an MCP server (and the Record preset): its address, how it signs in (on the server's own page with
 * OAuth, or a pasted API key), who may see what it brings in. "Sign in" goes to the server's consent page and comes
 * back to My Graph; the token is kept on the server, encrypted, and never shown here.
 */
import { useState, type FormEvent } from "react";
import { Button, Field, Input, Select } from "@/components/ui";
import { useT } from "@/lib/i18n/client";
import type { ConnectionDTO, ConnectorInfo } from "@/lib/connectors";
import { RECORD_MCP_URL } from "@/lib/connectors/record/constants";
import { api } from "./bits";

type Mode = "oauth" | "key" | "none";

export function McpConnectForm({ info, family, existing, onDone, onCancel }: {
  info: ConnectorInfo; family: boolean; existing?: ConnectionDTO; onDone: (c: ConnectionDTO) => void; onCancel?: () => void;
}) {
  const t = useT();
  const record = info.id === "record";
  const cfg = existing?.config ?? {};
  const [serverUrl, setServerUrl] = useState(typeof cfg.serverUrl === "string" ? cfg.serverUrl : record ? RECORD_MCP_URL : "");
  const [mode, setMode] = useState<Mode>((cfg.authMode as Mode) ?? (record ? "oauth" : "oauth"));
  const [apiKey, setApiKey] = useState("");
  const [visibility, setVisibility] = useState(typeof cfg.visibility === "string" ? cfg.visibility : "private");
  const [label, setLabel] = useState(existing?.label ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const keySaved = existing?.secretsSaved.includes("apiKey");
  const server = record ? "Record" : (() => { try { return new URL(serverUrl).hostname; } catch { return t("connections.connectors.mcp.title"); } })();
  const visKey = family ? "visibility" : "visibilityOther";
  const id = (k: string) => `${info.id}-${existing?.id ?? "new"}-${k}`;

  async function signIn() {
    setBusy(true); setError(null);
    try {
      const r = await api<{ authorizeUrl: string }>("/api/connections/mcp/oauth/start", {
        method: "POST",
        json: existing
          ? { connectionId: existing.id, config: { serverUrl, visibility } }
          : { connector: info.id, label: label.trim() || undefined, config: { serverUrl, visibility } },
      });
      window.location.assign(r.authorizeUrl);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("connections.errors.generic"));
      setBusy(false);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (mode === "oauth") return void signIn();
    setBusy(true); setError(null); setSaved(false);
    const config = { serverUrl: serverUrl.trim(), authMode: mode, visibility };
    const secrets = mode === "key" && apiKey.trim() ? { apiKey: apiKey.trim() } : {};
    try {
      const res = existing
        ? await api<{ connection: ConnectionDTO }>(`/api/connections/${existing.id}`, { method: "PATCH", json: { label: label || undefined, config, secrets } })
        : await api<{ connection: ConnectionDTO }>("/api/connections", { method: "POST", json: { connector: info.id, label: label.trim() || undefined, config, secrets } });
      setApiKey("");
      setSaved(!!existing);
      onDone(res.connection);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("connections.errors.generic"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      {!existing && <p className="max-w-[65ch] text-sm text-muted">{t(`connections.connectors.${info.id}.help`)}</p>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t("mcp.auth.serverUrl")} hint={t("mcp.auth.serverUrlHint")} className="sm:col-span-2">
          <Input id={id("url")} value={serverUrl} onChange={(e) => { setServerUrl(e.target.value); setSaved(false); }} inputMode="url" spellCheck={false}
            autoComplete="off" placeholder={record ? RECORD_MCP_URL : "https://…/mcp"} required disabled={busy} />
        </Field>
        <fieldset className="sm:col-span-2">
          <legend className="mb-1.5 text-sm font-medium">{t("mcp.auth.label")}</legend>
          <div className="space-y-2">
            {(["oauth", "key", ...(record ? [] : ["none"])] as Mode[]).map((m) => (
              <label key={m} className="flex cursor-pointer items-start gap-2.5">
                <input type="radio" name={id("mode")} value={m} checked={mode === m} onChange={() => { setMode(m); setSaved(false); }} className="mt-1 accent-[var(--accent)]" disabled={busy} />
                <span>
                  <span className="block text-[15px]">{t(`mcp.auth.${m}`)}</span>
                  {m !== "none" && <span className="block text-sm text-muted">{t(`mcp.auth.${m}Hint`)}</span>}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        {mode === "key" && (
          <Field label={t("mcp.auth.apiKey")} hint={keySaved ? t("mcp.auth.apiKeySaved") : t("connections.fields.apiKey.hint")} className="sm:col-span-2">
            <Input id={id("key")} type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="new-password" spellCheck={false}
              placeholder={keySaved ? "••••••••" : record ? "rk_…" : ""} required={!keySaved} disabled={busy} />
          </Field>
        )}
        <Field label={t("connections.fields.visibility.label")}>
          <Select value={visibility} onChange={(e) => setVisibility(e.target.value)} disabled={busy}>
            {(["private", "parents", "household"] as const).map((v) => <option key={v} value={v}>{t(`connections.${visKey}.${v}`)}</option>)}
          </Select>
        </Field>
        <Field label={t("connections.fields.label.label")} hint={t("connections.fields.label.hint")}>
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={record ? "Record" : t("connections.connectors.mcp.title")} maxLength={120} disabled={busy} />
        </Field>
      </div>
      {error && <p role="alert" className="rounded-md bg-danger-tint px-3 py-2 text-sm text-danger">{error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={busy || !serverUrl.trim()}>
          {mode === "oauth"
            ? busy ? t("mcp.auth.signingIn") : existing ? t("mcp.auth.signInAgain") : t("mcp.auth.signIn", { server })
            : busy ? (existing ? t("connections.actions.saving") : t("connections.connecting")) : existing ? t("connections.actions.save") : t("connections.connect")}
        </Button>
        {onCancel && <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>{t("connections.cancel")}</Button>}
        {saved && <span className="text-sm text-muted" role="status">{t("connections.actions.saved")}</span>}
      </div>
    </form>
  );
}
