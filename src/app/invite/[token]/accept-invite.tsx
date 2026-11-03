"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { Button, Input } from "@/components/ui";
import type { InvitePreview } from "@/lib/graphs";
import { api, errorFields, errorMessage, type FieldErrors } from "@/lib/auth/client/api";
import { describedBy, Field } from "@/lib/auth/client/field";
import { ErrorNote } from "@/app/login/notes";

type Props = { token: string; invite: InvitePreview; signedInAs: { name: string; email: string } | null };

/** Join, sign in then join, or make an account then join: whichever fits who opened the link. */
export function AcceptInvite({ token, invite, signedInAs }: Props) {
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<FieldErrors>({});
  const next = `/invite/${token}`;

  if (invite.state !== "open") {
    const why = invite.state === "accepted" ? "This invite has already been used." : invite.state === "expired" ? "This invite has expired. Ask for a new one." : "This invite was cancelled. Ask for a new one.";
    return (
      <div className="space-y-5">
        <p>{why}</p>
        {invite.state === "accepted" && !signedInAs && (
          <Link href="/login" className="inline-flex h-10 items-center rounded-md bg-fg px-4 text-sm font-medium text-bg hover:bg-fg/85">Sign in</Link>
        )}
        {signedInAs && <Link href="/" className="text-accent hover:underline">Open My Graph</Link>}
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
          <p>You&apos;re signed in as {signedInAs.email}, but this invite is for {invite.email}.</p>
          <Button type="button" variant="secondary" className="h-10" disabled={busy}
            onClick={() => void run(async () => { await fetch("/api/auth/logout", { method: "POST" }); return next; })}>
            {busy ? "Signing out…" : "Sign out and use this invite"}
          </Button>
        </div>
      );
    }
    return (
      <div className="space-y-4">
        <p>You&apos;re signed in as {signedInAs.name}. Joining adds {invite.graphName} to your graphs and opens it.</p>
        <Button type="button" className="h-11 w-full text-[15px]" disabled={busy} onClick={() => void run(async () => { await accept({}); return "/"; })}>
          {busy ? "Joining…" : `Join ${invite.graphName}`}
        </Button>
        <ErrorNote message={error} />
      </div>
    );
  }

  if (invite.hasAccount) {
    const signIn = (e: FormEvent) => {
      e.preventDefault();
      if (!password) { setFields({ password: "Enter your password." }); return; }
      void run(async () => {
        const r = await api<{ pending: boolean }>("/api/auth/login", { json: { email: invite.email, password } });
        if (r.pending) return `/login/pending`;
        await accept({});
        return "/";
      });
    };
    return (
      <form onSubmit={signIn} noValidate className="space-y-4" aria-label="Sign in and join">
        <p className="text-sm text-muted">You already use My Graph with this email. Sign in to join.</p>
        <Field id="inv-email" label="Email"><Input id="inv-email" value={invite.email} readOnly className="h-10 text-muted" /></Field>
        <Field id="inv-password" label="Password" error={fields.password}>
          <Input id="inv-password" type="password" autoComplete="current-password" autoFocus value={password} className="h-10"
            onChange={(e) => setPassword(e.target.value)} aria-invalid={!!fields.password || undefined} aria-describedby={describedBy("inv-password", fields.password)} />
        </Field>
        <ErrorNote message={error && !fields.password ? error : null} />
        <Button type="submit" className="h-11 w-full text-[15px]" disabled={busy}>{busy ? "Joining…" : `Sign in and join ${invite.graphName}`}</Button>
        <p className="text-sm text-muted">Signing in with a passkey? <Link href={`/login?next=${encodeURIComponent(next)}`} className="text-accent hover:underline">Use the sign-in page</Link>, then open this link again.</p>
      </form>
    );
  }

  const create = (e: FormEvent) => {
    e.preventDefault();
    const f: FieldErrors = {};
    if (!name.trim()) f.name = "Enter your name.";
    if (password.length < 10) f.password = "Use at least 10 characters.";
    if (Object.keys(f).length) { setFields(f); return; }
    void run(async () => { await accept({ name: name.trim(), password }); return "/"; });
  };
  return (
    <form onSubmit={create} noValidate className="space-y-4" aria-label="Make your account and join">
      <Field id="inv-email" label="Email" hint="The invite is for this address.">
        <Input id="inv-email" value={invite.email} readOnly className="h-10 text-muted" aria-describedby="inv-email-hint" />
      </Field>
      <Field id="inv-name" label="Your name" error={fields.name}>
        <Input id="inv-name" autoComplete="name" autoFocus value={name} maxLength={80} className="h-10"
          onChange={(e) => setName(e.target.value)} aria-invalid={!!fields.name || undefined} aria-describedby={describedBy("inv-name", fields.name)} />
      </Field>
      <Field id="inv-password" label="Choose a password" hint="At least 10 characters." error={fields.password}>
        <Input id="inv-password" type="password" autoComplete="new-password" value={password} className="h-10"
          onChange={(e) => setPassword(e.target.value)} aria-invalid={!!fields.password || undefined}
          aria-describedby={describedBy("inv-password", fields.password, true)} />
      </Field>
      <ErrorNote message={error && !fields.name && !fields.password ? error : null} />
      <Button type="submit" className="h-11 w-full text-[15px]" disabled={busy}>{busy ? "Making your account…" : `Make my account and join`}</Button>
      <p className="text-sm text-muted">Your account is your own. You get a private graph of your own too, and {invite.inviterName.split(/\s+/)[0]} can&apos;t see it.</p>
    </form>
  );
}
