"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { Button, Input } from "@/components/ui";
import type { InvitePreview } from "@/lib/graphs";
import { api, errorFields, errorMessage, type FieldErrors } from "@/lib/auth/client/api";
import { describedBy, Field } from "@/lib/auth/client/field";
import { ErrorNote } from "@/app/login/notes";
import { useT } from "@/lib/i18n/client";

type Props = { token: string; invite: InvitePreview; signedInAs: { name: string; email: string } | null };

/** Join, sign in then join, or make an account then join: whichever fits who opened the link. */
export function AcceptInvite({ token, invite, signedInAs }: Props) {
  const t = useT();
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<FieldErrors>({});
  const next = `/invite/${token}`;

  if (invite.state !== "open") {
    const why = invite.state === "accepted" ? t("auth.invite.used") : invite.state === "expired" ? t("auth.invite.expired") : t("auth.invite.revoked");
    return (
      <div className="space-y-5">
        <p>{why}</p>
        {invite.state === "accepted" && !signedInAs && (
          <Link href="/login" className="inline-flex h-10 items-center rounded-md bg-fg px-4 text-sm font-medium text-bg hover:bg-fg/85">{t("auth.invite.signIn")}</Link>
        )}
        {signedInAs && <Link href="/" className="text-accent hover:underline">{t("auth.invite.openApp")}</Link>}
      </div>
    );
  }

  const accept = (body: Record<string, string>) => api(`/api/invites/${encodeURIComponent(token)}/accept`, { json: body });

  async function run(fn: () => Promise<string>) {
    setBusy(true); setError(null); setFields({});
    try {
      window.location.assign(await fn());
    } catch (e) {
      setFields(errorFields(e));
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  if (signedInAs) {
    const sameEmail = signedInAs.email.toLowerCase() === invite.email.toLowerCase();
    if (!sameEmail) {
      return (
        <div className="space-y-5">
          <p>{t("auth.invite.otherAccount", { email: signedInAs.email, inviteEmail: invite.email })}</p>
          <Button type="button" variant="secondary" className="h-10" disabled={busy}
            onClick={() => void run(async () => { await fetch("/api/auth/logout", { method: "POST" }); return next; })}>
            {busy ? t("auth.invite.signingOut") : t("auth.invite.signOutAndUse")}
          </Button>
        </div>
      );
    }
    return (
      <div className="space-y-4">
        <p>{t("auth.invite.signedInAs", { name: signedInAs.name, graph: invite.graphName })}</p>
        <Button type="button" className="h-11 w-full text-[15px]" disabled={busy} onClick={() => void run(async () => { await accept({}); return "/"; })}>
          {busy ? t("auth.invite.joining") : t("auth.invite.join", { graph: invite.graphName })}
        </Button>
        <ErrorNote message={error} />
      </div>
    );
  }

  if (invite.hasAccount) {
    const signIn = (e: FormEvent) => {
      e.preventDefault();
      if (!password) { setFields({ password: t("auth.invite.errPassword") }); return; }
      void run(async () => {
        const r = await api<{ pending: boolean }>("/api/auth/login", { json: { email: invite.email, password } });
        if (r.pending) return `/login/pending`;
        await accept({});
        return "/";
      });
    };
    return (
      <form onSubmit={signIn} noValidate className="space-y-4" aria-label={t("auth.invite.signInFormLabel")}>
        <p className="text-sm text-muted">{t("auth.invite.hasAccount")}</p>
        <Field id="inv-email" label={t("auth.invite.email")}><Input id="inv-email" value={invite.email} readOnly className="h-10 text-muted" /></Field>
        <Field id="inv-password" label={t("auth.invite.password")} error={fields.password}>
          <Input id="inv-password" type="password" autoComplete="current-password" autoFocus value={password} className="h-10"
            onChange={(e) => setPassword(e.target.value)} aria-invalid={!!fields.password || undefined} aria-describedby={describedBy("inv-password", fields.password)} />
        </Field>
        <ErrorNote message={error && !fields.password ? error : null} />
        <Button type="submit" className="h-11 w-full text-[15px]" disabled={busy}>{busy ? t("auth.invite.joining") : t("auth.invite.signInAndJoin", { graph: invite.graphName })}</Button>
        <p className="text-sm text-muted">{t("auth.invite.passkeyNote")} <Link href={`/login?next=${encodeURIComponent(next)}`} className="text-accent hover:underline">{t("auth.invite.passkeyLink")}</Link>{t("auth.invite.passkeyAfter")}</p>
      </form>
    );
  }

  const create = (e: FormEvent) => {
    e.preventDefault();
    const f: FieldErrors = {};
    if (!name.trim()) f.name = t("auth.invite.errName");
    if (password.length < 10) f.password = t("auth.invite.errShort");
    if (Object.keys(f).length) { setFields(f); return; }
    void run(async () => { await accept({ name: name.trim(), password }); return "/"; });
  };
  return (
    <form onSubmit={create} noValidate className="space-y-4" aria-label={t("auth.invite.createFormLabel")}>
      <Field id="inv-email" label={t("auth.invite.email")} hint={t("auth.invite.emailHint")}>
        <Input id="inv-email" value={invite.email} readOnly className="h-10 text-muted" aria-describedby="inv-email-hint" />
      </Field>
      <Field id="inv-name" label={t("auth.invite.name")} error={fields.name}>
        <Input id="inv-name" autoComplete="name" autoFocus value={name} maxLength={80} className="h-10"
          onChange={(e) => setName(e.target.value)} aria-invalid={!!fields.name || undefined} aria-describedby={describedBy("inv-name", fields.name)} />
      </Field>
      <Field id="inv-password" label={t("auth.invite.choosePassword")} hint={t("auth.invite.passwordHint")} error={fields.password}>
        <Input id="inv-password" type="password" autoComplete="new-password" value={password} className="h-10"
          onChange={(e) => setPassword(e.target.value)} aria-invalid={!!fields.password || undefined}
          aria-describedby={describedBy("inv-password", fields.password, true)} />
      </Field>
      <ErrorNote message={error && !fields.name && !fields.password ? error : null} />
      <Button type="submit" className="h-11 w-full text-[15px]" disabled={busy}>{busy ? t("auth.invite.making") : t("auth.invite.make")}</Button>
      <p className="text-sm text-muted">{t("auth.invite.ownAccount", { inviter: invite.inviterName.split(/\s+/)[0] })}</p>
    </form>
  );
}
