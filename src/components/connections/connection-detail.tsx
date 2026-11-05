"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { clsx } from "clsx";
import { ArrowLeft } from "lucide-react";
import { Button, buttonClass, Section } from "@/components/ui";
import { useFormatDate, useT } from "@/lib/i18n/client";
import type { ConnectionDTO, ConnectorInfo, RunDTO } from "@/lib/connectors";
import { api, ConnectorIcon, CountsLine, StatusDot, useStatusText, type Person } from "./bits";
import { ConnectForm } from "./connect-form";
import { McpConnectForm } from "./mcp-form";
import { McpTools } from "./mcp-tools";
import { appById } from "@/lib/connectors/mcp/directory";
import { isOAuthConnector, SignInAgain } from "./oauth-connect";
import { OAuthSettings } from "./oauth-settings";

const MCP = new Set(["mcp", "record"]);
import { DisconnectDialog } from "./disconnect-dialog";

/** One connection: status and actions, its recent checks (the run log), and its settings. */
export function ConnectionDetail({ initial, runs: initialRuns, info, people, family }: {
  initial: ConnectionDTO; runs: RunDTO[]; info: ConnectorInfo | null; people: Person[]; family: boolean;
}) {
  const t = useT();
  const router = useRouter();
  const statusText = useStatusText();
  const [c, setC] = useState(initial);
  const [runs, setRuns] = useState(initialRuns);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [signin, setSignin] = useState<string | null>(null);
  const mcp = MCP.has(c.connector);

  // Back from the server's sign-in page: say how it went (?signin=ok or the reason), then tidy the address.
  useEffect(() => {
    const msg = new URLSearchParams(window.location.search).get("signin");
    if (!msg) return;
    setSignin(msg);
    window.history.replaceState(null, "", window.location.pathname + window.location.hash);
  }, []);

  const reload = useCallback(async () => {
    const d = await api<{ connection: ConnectionDTO; runs: RunDTO[] }>(`/api/connections/${c.id}`).catch(() => null);
    if (d) { setC(d.connection); setRuns(d.runs); }
  }, [c.id]);

  const checking = c.status === "running" || c.status === "new" || runs[0]?.status === "running";
  useEffect(() => {
    if (!checking) return;
    const id = setInterval(() => { void reload(); }, 2500);
    return () => clearInterval(id);
  }, [checking, reload]);

  const act = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await fn(); await reload(); } catch (e) { setError(e instanceof Error ? e.message : t("connections.errors.generic")); } finally { setBusy(false); }
  };
  const runNow = () => act(async () => { await api(`/api/connections/${c.id}/run`, { method: "POST" }); setC((x) => ({ ...x, status: "running" })); });
  const setPaused = (paused: boolean) => act(async () => { await api(`/api/connections/${c.id}`, { method: "PATCH", json: { paused } }); });
  const host = typeof c.config.feedHost === "string" ? c.config.feedHost : null;

  return (
    <div className="space-y-10">
      <div>
        <Link href="/connections" className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg">
          <ArrowLeft className="size-4" aria-hidden />{t("connections.actions.back")}
        </Link>
        <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
          <div className="min-w-0">
            <h1 className="flex items-center gap-2.5 text-[28px]/[1.15] font-semibold tracking-[-0.02em]">
              {info && <ConnectorIcon icon={info.icon} className="size-5" />}{c.label}
            </h1>
            <p className="mt-1 text-sm text-muted">
              {info ? t(`connections.connectors.${info.id}.title`) : c.connector}{host ? `, ${t("connections.detail.from", { host }).toLowerCase()}` : ""}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {c.status !== "paused" && <Button variant="secondary" disabled={busy || c.status === "running"} onClick={runNow}>{t("connections.actions.runNow")}</Button>}
            {c.status === "paused"
              ? <Button variant="secondary" disabled={busy} onClick={() => setPaused(false)}>{t("connections.actions.resume")}</Button>
              : <Button variant="ghost" disabled={busy} onClick={() => setPaused(true)}>{t("connections.actions.pause")}</Button>}
            <Button variant="ghost" disabled={busy} onClick={() => setLeaving(true)}>{t("connections.actions.disconnect")}</Button>
          </div>
        </header>
        <div className={clsx("mt-5 rounded-lg px-4 py-3", c.status === "needs_you" ? "bg-warn-tint" : "bg-surface")}>
          <p className={clsx("flex items-center gap-2 font-medium", c.status === "needs_you" && "text-warn")}><StatusDot status={c.status} />{statusText(c)}</p>
          <CountsLine c={c} />
          {c.counts.waiting > 0 && <Link href="/changes" className={clsx(buttonClass("primary", "sm"), "mt-3")}>{t("connections.actions.review")}</Link>}
        </div>
        {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
        {signin && (
          <p role="status" className={clsx("mt-3 rounded-md px-3 py-2 text-sm", signin === "ok" ? "bg-accent-tint text-accent" : "bg-danger-tint text-danger")}>
            {signin === "ok" ? t("mcp.auth.signedIn") : signin}
          </p>
        )}
        {isOAuthConnector(c.connector) && c.status === "needs_you" && ["signIn", "signInAgain", "scopeMissing", "oauthRefused"].includes(c.detailCode ?? "") && <SignInAgain c={c} />}
        {mcp && c.status === "needs_you" && c.detailCode === "signIn" && info && (
          <div className="mt-3"><McpConnectForm info={info} family={family} existing={{ ...c, config: { ...c.config, authMode: "oauth" } }} onDone={(next) => setC(next)} /></div>
        )}
        {c.connector === "aula" && c.status === "needs_you" && (
          <Link href="/connections/aula" className={clsx(buttonClass("primary", "sm"), "mt-3")}>{t("connections.actions.fix")}</Link>
        )}
        {c.connector === "record" && c.counts.total > 0 && (
          <Link href="/recordings" className={clsx(buttonClass("secondary", "sm"), "mt-3")}>{t("recordings.title")}</Link>
        )}
      </div>

      {mcp && <McpTools connectionId={c.id} refreshKey={c.lastRunAt} app={appById(c.config.directoryId)} />}

      <Section title={t("connections.detail.runsTitle")}>
        {runs.length === 0 ? <p className="text-sm text-muted">{t("connections.detail.noRuns")}</p> : (
          <ol className="divide-y divide-line rounded-lg bg-surface">
            {runs.map((r) => <RunItem key={r.id} r={r} />)}
          </ol>
        )}
      </Section>

      {info && (
        <div id="settings" className="scroll-mt-6">
          <Section title={t("connections.detail.settingsTitle")}>
            <p className="mb-4 max-w-[65ch] text-sm text-muted">{t(`connections.connectors.${info.id}.help`)}</p>
            {isOAuthConnector(c.connector)
              ? <OAuthSettings c={c} people={people} family={family} onDone={(next) => { setC(next); void reload(); }} />
              : mcp
              ? <McpConnectForm info={info} family={family} existing={c} onDone={(next) => { setC(next); void reload(); }} />
              : <ConnectForm info={info} people={people} family={family} existing={c} onDone={(next) => { setC(next); void reload(); }} />}
          </Section>
        </div>
      )}

      <DisconnectDialog connection={leaving ? c : null} onClose={() => setLeaving(false)} onDone={() => { router.push("/connections"); router.refresh(); }} />
    </div>
  );
}

function RunItem({ r }: { r: RunDTO }) {
  const t = useT();
  const fmt = useFormatDate();
  const streams = Object.entries(r.streams).map(([name, counts]) => {
    const parts = (["added", "updated", "cancelled", "unchanged", "skipped", "proposed"] as const)
      .filter((k) => (counts[k] ?? 0) > 0).map((k) => t(`connections.detail.part.${k}`, { count: counts[k] ?? 0 }));
    if (!parts.length && (counts.fetched ?? 0) > 0) parts.push(t("connections.detail.part.fetched", { count: counts.fetched ?? 0 }));
    return parts.length ? t("connections.detail.stream", { stream: t(`connections.detail.streams.${name}`, undefined, name), parts: parts.join(", ") }) : null;
  }).filter(Boolean) as string[];
  const status = r.status === "failed" && r.needsYou ? "failed" : r.status;
  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="font-medium">
          {t(`connections.detail.run.${status}`)}
          <span className="ml-2 text-sm font-normal text-muted">{r.trigger === "person" ? t("connections.detail.triggerPerson") : t("connections.detail.triggerSchedule")}</span>
        </p>
        <time className="text-sm text-muted" dateTime={r.startedAt}>{fmt(r.startedAt, "dateTime")}</time>
      </div>
      {r.error && <p className={clsx("mt-1 text-sm", r.needsYou ? "text-warn" : "text-danger")}>{r.error}</p>}
      {streams.length > 0 ? <ul className="mt-1 space-y-0.5 text-sm text-muted">{streams.map((s) => <li key={s}>{s}</li>)}</ul>
        : r.status === "done" && <p className="mt-1 text-sm text-muted">{t("connections.detail.nothingNew")}</p>}
      {r.changeSets.length > 0 && (
        <p className="mt-1 text-sm">
          <Link href={r.changeSets.length === 1 ? `/changes/${r.changeSets[0]}` : "/changes"} className="text-accent hover:underline">
            {t("connections.detail.proposals", { count: r.changeSets.length })}
          </Link>
        </p>
      )}
      {r.log.length > 0 && <ul className="mt-1 space-y-0.5 text-xs text-muted">{r.log.map((l, i) => <li key={i}>{l}</li>)}</ul>}
    </li>
  );
}
