"use client";
import { useState, type FormEvent } from "react";
import { Button, Field, Input, Select, Textarea } from "@/components/ui";
import { useT } from "@/lib/i18n/client";
import type { ConnectionDTO, ConnectorInfo } from "@/lib/connectors";
import { api, type Person } from "./bits";

const EVERY: { value: number; key: string }[] = [
  { value: 15, key: "m15" }, { value: 30, key: "m30" }, { value: 60, key: "h1" }, { value: 180, key: "h3" }, { value: 720, key: "h12" }, { value: 1440, key: "d1" },
];

type Values = Record<string, string>;

function initialValues(info: ConnectorInfo, existing?: ConnectionDTO): Values {
  const v: Values = {};
  for (const f of info.fields) {
    if (f.secret) { v[f.key] = ""; continue; }
    const cur = existing?.config[f.key];
    if (f.kind === "list") v[f.key] = Array.isArray(cur) ? cur.join("\n") : f.key === "folders" ? "INBOX" : "";
    else if (f.kind === "visibility") v[f.key] = typeof cur === "string" ? cur : "private";
    else if (f.kind === "number") v[f.key] = cur != null ? String(cur) : f.key === "port" ? "993" : "";
    else if (f.kind === "date") v[f.key] = typeof cur === "string" ? cur : f.key === "since" ? defaultSince() : "";
    else v[f.key] = cur != null ? String(cur) : "";
  }
  return v;
}

function defaultName(id: string, values: Values, t: (k: string, v?: Record<string, string | number>) => string): string {
  if (id === "imap") return "";
  if (id === "ics") {
    try {
      return t("connections.defaultIcsLabel", { host: new URL((values.url ?? "").trim().replace(/^webcals?:/i, "https:")).hostname.replace(/^www\./, "") });
    } catch {
      return "";
    }
  }
  return t(`connections.connectors.${id}.title`);
}

function defaultSince(): string {
  const d = new Date(Date.now() - 90 * 86_400_000);
  return d.toISOString().slice(0, 10);
}

/**
 * The form for one connector, drawn from its manifest's fields. Creates a connection, or (with `existing`) changes
 * one: secret fields start empty and keep the saved value unless something is typed.
 */
export function ConnectForm({ info, people, family, existing, onDone, onCancel }: {
  info: ConnectorInfo; people: Person[]; family: boolean; existing?: ConnectionDTO;
  onDone: (c: ConnectionDTO) => void; onCancel?: () => void;
}) {
  const t = useT();
  const [label, setLabel] = useState(existing?.label ?? "");
  const [every, setEvery] = useState(existing?.everyMinutes ?? info.schedule.everyMinutes);
  const [values, setValues] = useState<Values>(() => initialValues(info, existing));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const set = (k: string, v: string) => { setValues((p) => ({ ...p, [k]: v })); setSaved(false); };
  const fieldId = (k: string) => `${info.id}-${existing?.id ?? "new"}-${k}`;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    const config: Record<string, unknown> = {};
    const secrets: Record<string, string> = {};
    for (const f of info.fields) {
      const raw = values[f.key] ?? "";
      if (f.secret) { if (raw.trim()) secrets[f.key] = raw.trim(); continue; }
      if (f.kind === "list") config[f.key] = raw.split(/\n|,/).map((s) => s.trim()).filter(Boolean);
      else if (f.kind === "number") { if (raw.trim()) config[f.key] = Number(raw); }
      else if (f.kind === "person") config[f.key] = raw || null;
      else if (raw.trim()) config[f.key] = raw.trim();
    }
    // A new connection without a name gets one in the reader's language ("Aula-kalender", "Kalender fra dbu.dk").
    const name = label.trim() || (existing ? "" : defaultName(info.id, values, t));
    try {
      const res = existing
        ? await api<{ connection: ConnectionDTO }>(`/api/connections/${existing.id}`, { method: "PATCH", json: { label: label || undefined, everyMinutes: every, config, secrets } })
        : await api<{ connection: ConnectionDTO }>("/api/connections", { method: "POST", json: { connector: info.id, label: name || undefined, everyMinutes: every, config, secrets } });
      setSaved(!!existing);
      if (existing) setValues((p) => Object.fromEntries(Object.entries(p).map(([k, v]) => [k, info.fields.find((f) => f.key === k)?.secret ? "" : v])));
      onDone(res.connection);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("connections.errors.generic"));
    } finally {
      setBusy(false);
    }
  }

  const visKey = family ? "visibility" : "visibilityOther";
  return (
    <form onSubmit={submit} className="space-y-4">
      {!existing && <p className="max-w-[65ch] text-sm text-muted">{t(`connections.connectors.${info.id}.help`)}</p>}
      <div className="grid gap-4 sm:grid-cols-2">
        {info.fields.map((f) => {
          const label = t(`connections.fields.${f.key}.label`);
          const savedSecret = f.secret && existing?.secretsSaved.includes(f.key);
          const hint = savedSecret ? t("connections.fields.savedSecret") : t(`connections.fields.${f.key}.hint`, undefined, "");
          const wide = f.kind === "url" || f.kind === "list";
          const common = { id: fieldId(f.key), value: values[f.key] ?? "", disabled: busy };
          let control;
          if (f.kind === "person") {
            control = (
              <Select {...common} onChange={(e) => set(f.key, e.target.value)}>
                <option value="">{t("connections.fields.personNodeId.none")}</option>
                {people.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </Select>
            );
          } else if (f.kind === "visibility") {
            control = (
              <Select {...common} onChange={(e) => set(f.key, e.target.value)}>
                {(["private", "parents", "household"] as const).map((v) => <option key={v} value={v}>{t(`connections.${visKey}.${v}`)}</option>)}
              </Select>
            );
          } else if (f.kind === "list") {
            control = <Textarea {...common} rows={3} onChange={(e) => set(f.key, e.target.value)} placeholder={f.placeholder} />;
          } else {
            const type = f.kind === "password" ? "password" : f.kind === "number" ? "number" : f.kind === "date" ? "date" : f.kind === "url" ? "url" : "text";
            control = <Input {...common} type={type === "url" ? "text" : type} inputMode={type === "url" ? "url" : undefined} autoComplete={f.kind === "password" ? "new-password" : "off"}
              spellCheck={false} placeholder={savedSecret ? "••••••••" : f.placeholder} required={f.required && !savedSecret} onChange={(e) => set(f.key, e.target.value)} />;
          }
          return <Field key={f.key} label={label} hint={hint || undefined} className={wide ? "sm:col-span-2" : undefined}>{control}</Field>;
        })}
        <Field label={t("connections.fields.label.label")} hint={t("connections.fields.label.hint")}>
          <Input value={label} onChange={(e) => { setLabel(e.target.value); setSaved(false); }} placeholder={t(`connections.connectors.${info.id}.title`)} maxLength={120} disabled={busy} />
        </Field>
        <Field label={t("connections.fields.everyMinutes.label")}>
          <Select value={String(every)} onChange={(e) => { setEvery(Number(e.target.value)); setSaved(false); }} disabled={busy}>
            {EVERY.filter((o) => o.value >= 15).map((o) => <option key={o.value} value={o.value}>{t(`connections.every.${o.key}`)}</option>)}
          </Select>
        </Field>
      </div>
      {error && <p role="alert" className="rounded-md bg-danger-tint px-3 py-2 text-sm text-danger">{error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={busy}>
          {busy ? (existing ? t("connections.actions.saving") : t("connections.connecting")) : existing ? t("connections.actions.save") : t("connections.connect")}
        </Button>
        {onCancel && <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>{t("connections.cancel")}</Button>}
        {saved && <span className="text-sm text-muted" role="status">{t("connections.actions.saved")}</span>}
      </div>
    </form>
  );
}
