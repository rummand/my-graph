"use client";
/**
 * Connecting Gmail, Google Calendar, Google Drive, Outlook/OneDrive or Dropbox: a few settings, then "Sign in with …"
 * goes to the provider's own consent page and back. When this My Graph has no app registered with the provider yet,
 * the card says so and shows the step-by-step setup guide instead (with the exact redirect address to register).
 */
import { useEffect, useState, type FormEvent } from "react";
import { Check, Copy } from "lucide-react";
import { Button, Field, Input, Select } from "@/components/ui";
import { useT } from "@/lib/i18n/client";
import type { ConnectionDTO, ConnectorInfo } from "@/lib/connectors";
import { api, type Person } from "./bits";

export type ProviderId = "google" | "microsoft" | "dropbox" | "github" | "linear" | "slack" | "notion";
export const OAUTH_CONNECTORS: Record<string, ProviderId> = { gmail: "google", google_calendar: "google", google_drive: "google", google_contacts: "google", google_photos: "google", microsoft: "microsoft", dropbox: "dropbox", github_oauth: "github", linear_oauth: "linear", slack: "slack", notion: "notion" };
export const isOAuthConnector = (id: string) => Object.prototype.hasOwnProperty.call(OAUTH_CONNECTORS, id);
const PROVIDER_NAME: Record<ProviderId, string> = { google: "Google", microsoft: "Microsoft", dropbox: "Dropbox", github: "GitHub", linear: "Linear", slack: "Slack", notion: "Notion" };

export type ProvidersInfo = {
  providers: Record<ProviderId, { configured: boolean; missing: string[]; settings: string[] }>;
  redirectUri: string; origin: string; picker: boolean;
};

let cached: Promise<ProvidersInfo> | null = null;
/** Which providers this My Graph is set up for (asked once per page). */
export function useProviders(): { info: ProvidersInfo | null; error: string | null } {
  const [info, setInfo] = useState<ProvidersInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    cached ??= api<ProvidersInfo>("/api/connections/oauth/providers");
    cached.then(setInfo, (e) => { cached = null; setError(e instanceof Error ? e.message : String(e)); });
  }, []);
  return { info, error };
}

/** Send the person to the provider's consent page (a new connection, or signing in again to an existing one). */
export async function startSignIn(body: { connector?: string; connectionId?: string; label?: string; autoLabel?: boolean; config?: Record<string, unknown>; everyMinutes?: number }): Promise<void> {
  const r = await api<{ authorizeUrl: string }>("/api/connections/oauth/start", { method: "POST", json: body });
  window.location.assign(r.authorizeUrl);
}

function defaultSince(): string {
  return new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
}

export function OAuthConnectForm({ info, people, family, onCancel }: {
  info: ConnectorInfo; people: Person[]; family: boolean; onCancel?: () => void;
}) {
  const t = useT();
  const provider = OAUTH_CONNECTORS[info.id];
  const { info: setup, error: setupError } = useProviders();
  const [since, setSince] = useState(defaultSince);
  const [visibility, setVisibility] = useState("private");
  const [person, setPerson] = useState("");
  const [mail, setMail] = useState(true);
  const [calendar, setCalendar] = useState(true);
  const [directMessages, setDirectMessages] = useState(false);
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const visKey = family ? "visibility" : "visibilityOther";
  const name = PROVIDER_NAME[provider];

  if (setupError) return <p role="alert" className="text-sm text-danger">{setupError}</p>;
  if (!setup) return <p className="text-sm text-muted">{t("providers.checking")}</p>;
  const p = setup.providers[provider];
  if (!p.configured) {
    return (
      <div className="space-y-3">
        <div className="max-w-[65ch]">
          <p className="font-medium">{t("providers.notSetUpTitle")}</p>
          <p className="mt-1 text-sm text-muted">{t("providers.notSetUp", { provider: name })}</p>
        </div>
        <SetupGuide provider={provider} setup={setup} startOpen />
        {onCancel && <Button type="button" variant="ghost" size="sm" onClick={onCancel}>{t("connections.cancel")}</Button>}
      </div>
    );
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    const config: Record<string, unknown> = { visibility };
    if (info.id === "gmail" || info.id === "microsoft") config.since = since;
    if ((info.id === "google_calendar" || info.id === "microsoft") && person) config.personNodeId = person;
    if (info.id === "microsoft") Object.assign(config, { mail, calendar });
    if (info.id === "slack") config.directMessages = directMessages;
    try {
      // A new connection without a name gets one in the reader's language; the account is added after the sign-in.
      await startSignIn({ connector: info.id, label: label.trim() || t(`connections.connectors.${info.id}.title`), autoLabel: !label.trim(), config });
    } catch (err) {
      setError(err instanceof Error ? err.message : t("connections.errors.generic"));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <p className="max-w-[65ch] text-sm text-muted">{t(`connections.connectors.${info.id}.help`)} {t("providers.afterSignIn", { provider: name })}</p>
      <div className="grid gap-4 sm:grid-cols-2">
        {info.id === "microsoft" && (
          <fieldset className="flex flex-wrap gap-x-6 gap-y-2 sm:col-span-2">
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={mail} onChange={(e) => setMail(e.target.checked)} disabled={busy} />{t("providers.settings.mailOn")}</label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={calendar} onChange={(e) => setCalendar(e.target.checked)} disabled={busy} />{t("providers.settings.calendarOn")}</label>
          </fieldset>
        )}
        {info.id === "slack" && (
          <label className="flex items-start gap-2 text-sm sm:col-span-2">
            <input type="checkbox" className="mt-1" checked={directMessages} onChange={(e) => setDirectMessages(e.target.checked)} disabled={busy} />
            <span>{t("providers.settings.slackDms")}<span className="block text-muted">{t("providers.settings.slackDmsHint")}</span></span>
          </label>
        )}
        {(info.id === "gmail" || (info.id === "microsoft" && mail)) && (
          <Field label={t("connections.fields.since.label")} hint={t("connections.fields.since.hint")}>
            <Input type="date" value={since} onChange={(e) => setSince(e.target.value)} disabled={busy} required />
          </Field>
        )}
        {(info.id === "google_calendar" || (info.id === "microsoft" && calendar)) && (
          <Field label={t("connections.fields.personNodeId.label")} hint={t("connections.fields.personNodeId.hint")}>
            <Select value={person} onChange={(e) => setPerson(e.target.value)} disabled={busy}>
              <option value="">{t("connections.fields.personNodeId.none")}</option>
              {people.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
            </Select>
          </Field>
        )}
        <Field label={t("connections.fields.visibility.label")}>
          <Select value={visibility} onChange={(e) => setVisibility(e.target.value)} disabled={busy}>
            {(["private", "parents", "household"] as const).map((v) => <option key={v} value={v}>{t(`connections.${visKey}.${v}`)}</option>)}
          </Select>
        </Field>
        <Field label={t("connections.fields.label.label")} hint={t("connections.fields.label.hint")}>
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t(`connections.connectors.${info.id}.title`)} maxLength={120} disabled={busy} />
        </Field>
      </div>
      {error && <p role="alert" className="rounded-md bg-danger-tint px-3 py-2 text-sm text-danger">{error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={busy}>{busy ? t("providers.signingIn") : t(`providers.signIn.${provider}`)}</Button>
        {onCancel && <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>{t("connections.cancel")}</Button>}
      </div>
      {provider === "google" && <UnverifiedNote />}
    </form>
  );
}

function UnverifiedNote() {
  const t = useT();
  return (
    <details className="max-w-[65ch] text-sm">
      <summary className="cursor-pointer text-muted hover:text-fg">{t("providers.unverifiedTitle")}</summary>
      <p className="mt-2 text-muted">{t("providers.unverified")}</p>
    </details>
  );
}

const STEPS: Record<ProviderId, number> = { google: 8, microsoft: 7, dropbox: 5, github: 7, linear: 5, slack: 6, notion: 6 };

/** The step-by-step guide for whoever runs My Graph: register the household's own app, then set the server settings. */
export function SetupGuide({ provider, setup, startOpen = false }: { provider: ProviderId; setup: ProvidersInfo; startOpen?: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(startOpen);
  const p = setup.providers[provider];
  const name = PROVIDER_NAME[provider];
  return (
    <div>
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="text-sm text-accent hover:underline">
        {open ? t("providers.hideGuide") : t("providers.showGuide")}
      </button>
      {open && (
        <section aria-label={t("providers.guideFor", { provider: name })} className="mt-3 max-w-[70ch] space-y-4 rounded-lg bg-surface-2 p-4">
          <h3 className="font-semibold">{t("providers.guideFor", { provider: name })}</h3>
          <ol className="list-decimal space-y-2 pl-5 text-sm marker:text-muted">
            {Array.from({ length: STEPS[provider] }, (_, i) => <li key={i}>{t(`providers.guides.${provider}.s${i + 1}`)}</li>)}
          </ol>
          <div>
            <p className="text-sm font-medium">{t("providers.redirectLabel")}</p>
            <CopyLine value={setup.redirectUri} />
          </div>
          <div>
            <p className="text-sm font-medium">{t("providers.envLabel")}</p>
            <pre className="mt-1 overflow-x-auto rounded-md bg-surface px-3 py-2 font-mono text-xs leading-relaxed">
              {p.settings.map((s) => `${s}=${s === "MICROSOFT_TENANT" ? "common" : "…"}`).join("\n")}
            </pre>
            <p className="mt-1 text-xs text-muted">{t("providers.envNote")}</p>
            {p.missing.length > 0 && <p className="mt-1 text-xs text-warn">{t("providers.missing", { names: p.missing.join(", ") })}</p>}
          </div>
          {provider === "google" && (
            <div>
              <p className="text-sm font-medium">{t("providers.unverifiedTitle")}</p>
              <p className="mt-1 text-sm text-muted">{t("providers.unverified")}</p>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function CopyLine({ value }: { value: string }) {
  const t = useT();
  const [done, setDone] = useState(false);
  return (
    <div className="mt-1 flex items-center gap-2">
      <code className="min-w-0 flex-1 truncate rounded-md bg-surface px-3 py-2 font-mono text-xs">{value}</code>
      <Button type="button" size="sm" variant="secondary" onClick={() => { void navigator.clipboard?.writeText(value).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); }); }}>
        {done ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}
        <span className="ml-1.5">{done ? t("providers.copied") : t("providers.copy")}</span>
      </Button>
    </div>
  );
}

/** For a connection that needs a new sign-in: the one button that fixes it. */
export function SignInAgain({ c }: { c: ConnectionDTO }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const provider = OAUTH_CONNECTORS[c.connector];
  return (
    <div className="mt-3">
      <Button disabled={busy} onClick={async () => {
        setBusy(true); setError(null);
        try { await startSignIn({ connectionId: c.id }); } catch (e) { setError(e instanceof Error ? e.message : t("connections.errors.generic")); setBusy(false); }
      }}>{busy ? t("providers.signingIn") : provider ? t(`providers.signIn.${provider}`) : t("providers.signInAgain")}</Button>
      {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
    </div>
  );
}
