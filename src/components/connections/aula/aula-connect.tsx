"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { clsx } from "clsx";
import { Check, Copy, Download } from "lucide-react";
import { Button, buttonClass, Field, Section, Select } from "@/components/ui";
import { useFormatDate, useT } from "@/lib/i18n/client";
import type { AulaStatus } from "@/lib/connectors/dk/aula/pairing";
import { api, StatusDot } from "../bits";

type Pairing = { code: string; expiresAt: string };
type Visibility = "private" | "parents" | "household";

/** The Connect Aula helper page: status, a pairing code, the helper download and what happens to the sign-in. */
export function AulaConnect({ initial }: { initial: AulaStatus }) {
  const t = useT();
  const fmt = useFormatDate();
  const [status, setStatus] = useState(initial);
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [visibility, setVisibility] = useState<Visibility>((initial.connection?.config.visibility as Visibility | undefined) ?? "parents");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [justConnected, setJustConnected] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const reload = useCallback(async () => {
    const s = await api<AulaStatus>("/api/connections/aula").catch(() => null);
    if (!s) return;
    // The helper handed in the tokens: the code is spent and the connection is signed in.
    if (pairing && !s.pairing && s.signedIn) {
      setJustConnected(true);
      setPairing(null);
    }
    setStatus(s);
  }, [pairing]);

  const live = !!pairing && Date.parse(pairing.expiresAt) > now;
  useEffect(() => {
    if (!pairing) return;
    const id = setInterval(() => { setNow(Date.now()); void reload(); }, 3000);
    return () => clearInterval(id);
  }, [pairing, reload]);

  const start = async () => {
    setBusy(true); setError(null); setJustConnected(false);
    try {
      const p = await api<Pairing>("/api/connections/aula", { method: "POST", json: { visibility } });
      setPairing(p);
      setNow(Date.now());
      void reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("aula.errors.generic"));
    } finally {
      setBusy(false);
    }
  };

  const copy = async (what: string, text: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(what); setTimeout(() => setCopied(null), 1500); } catch { /* select it by hand */ }
  };

  const c = status.connection;
  const command = pairing ? `node connect-aula.mjs --code ${pairing.code}` : "node connect-aula.mjs";

  return (
    <div className="space-y-10">
      {c && (
        <Section title={t("aula.status.title")}>
          <div className="rounded-lg bg-surface px-4 py-4">
            <p className="flex items-center gap-2">
              <StatusDot status={c.status} />
              <span className={clsx("text-sm", c.status === "needs_you" ? "text-warn" : "text-muted")}>
                {justConnected ? t("aula.status.justConnected")
                  : !status.signedIn ? t("aula.status.waiting")
                  : c.status === "needs_you" ? t("aula.status.needsYou")
                  : c.status === "error" ? t("aula.status.error")
                  : t("aula.status.ok")}
              </span>
            </p>
            {status.signedIn && (
              <p className="mt-2 text-sm">
                {status.account?.name ? t("aula.status.connectedAs", { name: status.account.name }) : t("aula.status.connected")}
                {status.account?.children.length ? ` ${t("aula.status.children", { names: status.account.children.map((k) => k.institution ? `${k.name} (${k.institution})` : k.name).join(", ") })}` : ""}
              </p>
            )}
            <Link href={`/connections/${c.id}`} className={clsx(buttonClass("secondary", "sm"), "mt-3")}>{t("aula.status.open")}</Link>
          </div>
        </Section>
      )}

      <Section title={t("aula.steps.title")}>
        <p className="mb-6 max-w-[65ch] text-sm text-muted">{t("aula.steps.lead")}</p>
        {error && <p role="alert" className="mb-4 rounded-md bg-surface px-3 py-2 text-sm text-danger">{error}</p>}
        <ol className="space-y-8">
          <Step n={1} title={t("aula.steps.one.title")}>
            <p className="max-w-[60ch] text-sm text-muted">{t("aula.steps.one.body")}</p>
            {!c && (
              <Field label={t("aula.visibility.label")} hint={t("aula.visibility.hint")} className="mt-3 max-w-xs">
                <Select value={visibility} onChange={(e) => setVisibility(e.target.value as Visibility)}>
                  <option value="private">{t("connections.visibility.private")}</option>
                  <option value="parents">{t("connections.visibility.parents")}</option>
                  <option value="household">{t("connections.visibility.household")}</option>
                </Select>
              </Field>
            )}
            {pairing && live ? (
              <div className="mt-3">
                <p className="text-sm text-muted">{t("aula.steps.one.code")}</p>
                <p className="mt-1 flex flex-wrap items-center gap-3">
                  <span className="select-all text-[28px]/[1.15] font-semibold tabular-nums tracking-[0.08em]" aria-live="polite">{pairing.code}</span>
                  <Button size="sm" variant="ghost" onClick={() => copy("code", pairing.code)}>
                    {copied === "code" ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}
                    {copied === "code" ? t("aula.steps.one.copied") : t("aula.steps.one.copy")}
                  </Button>
                </p>
                <p className="mt-1 text-sm text-muted">{t("aula.steps.one.expires", { time: fmt(pairing.expiresAt, "time") })}</p>
                <Button size="sm" variant="secondary" className="mt-3" disabled={busy} onClick={start}>{t("aula.steps.one.again")}</Button>
              </div>
            ) : (
              <>
                {pairing && <p className="mt-3 text-sm text-warn">{t("aula.steps.one.expired")}</p>}
                <Button className="mt-3" disabled={busy} onClick={start}>{pairing ? t("aula.steps.one.again") : t("aula.steps.one.action")}</Button>
              </>
            )}
          </Step>

          <Step n={2} title={t("aula.steps.two.title")}>
            <p className="max-w-[60ch] text-sm text-muted">{t("aula.steps.two.body")}</p>
            <div className="mt-3 flex max-w-xl items-center gap-2 rounded-md bg-surface-2 px-3 py-2">
              <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-sm">{command}</code>
              <Button size="sm" variant="ghost" onClick={() => copy("cmd", command)} aria-label={t("aula.steps.one.copy")}>
                {copied === "cmd" ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}
              </Button>
            </div>
            <a href="/api/connections/aula/helper" download className={clsx(buttonClass("secondary", "sm"), "mt-3")}>
              <Download className="size-4" aria-hidden />{t("aula.steps.two.download")}
            </a>
            <p className="mt-2 max-w-[60ch] text-sm text-muted">{t("aula.steps.two.read")}</p>
          </Step>

          <Step n={3} title={t("aula.steps.three.title")}>
            <p className="max-w-[60ch] text-sm text-muted">{t("aula.steps.three.body")}</p>
            <p className="mt-2 max-w-[60ch] text-sm">{t("aula.steps.three.phone")}</p>
          </Step>

          <Step n={4} title={t("aula.steps.four.title")}>
            <p className="max-w-[60ch] text-sm text-muted">{t("aula.steps.four.body")}</p>
            {pairing && live && <p className="mt-2 flex items-center gap-2 text-sm"><StatusDot status="running" />{t("aula.steps.four.watching")}</p>}
            {justConnected && <p className="mt-2 text-sm text-accent">{t("aula.status.justConnected")}</p>}
          </Step>
        </ol>
      </Section>

      <Section title={t("aula.mcp.title")}>
        <p className="max-w-[65ch] text-sm text-muted">{t("aula.mcp.body")}</p>
        <pre className="mt-3 max-w-xl overflow-x-auto rounded-md bg-surface-2 px-3 py-2 font-mono text-sm">{`aula tokens export ./aula-bundle\nnode connect-aula.mjs --aula-mcp ./aula-bundle`}</pre>
      </Section>

      <Section title={t("aula.how.title")}>
        <ul className="max-w-[65ch] list-disc space-y-2 pl-5 text-sm text-muted marker:text-line">
          {(["mitid", "tokens", "renew", "reads", "sensitive", "never", "proposals"] as const).map((k) => <li key={k}>{t(`aula.how.${k}`)}</li>)}
        </ul>
      </Section>
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-4">
      <span aria-hidden className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-2 text-xs font-semibold tabular-nums text-muted">{n}</span>
      <div className="min-w-0 flex-1">
        <h3 className="font-medium">{title}</h3>
        <div className="mt-1">{children}</div>
      </div>
    </li>
  );
}
