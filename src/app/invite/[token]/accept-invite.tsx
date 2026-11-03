"use client";

import { useState } from "react";
import type { InvitePreview } from "@/lib/graphs";

type Props = { token: string; invite: InvitePreview; signedInAs: { name: string; email: string } | null };

export function AcceptInvite({ token, invite, signedInAs }: Props) {
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (invite.state !== "open") {
    const why = invite.state === "accepted" ? "This invite has already been used." : invite.state === "expired" ? "This invite has expired. Ask for a new one." : "This invite was cancelled.";
    return <p className="mt-6 text-sm text-muted">{why}{invite.state === "accepted" ? <> <a className="text-accent underline" href="/login">Sign in</a> to open it.</> : null}</p>;
  }

  async function accept(body: Record<string, string>) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/invites/${encodeURIComponent(token)}/accept`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "That didn't work. Please try again.");
      window.location.assign("/");
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't work. Please try again.");
      setBusy(false);
    }
  }

  const next = `/invite/${token}`;
  if (signedInAs) {
    const sameEmail = signedInAs.email.toLowerCase() === invite.email.toLowerCase();
    return (
      <div className="mt-6 space-y-3">
        {sameEmail ? (
          <button type="button" disabled={busy} onClick={() => accept({})}
            className="w-full rounded-lg bg-accent px-4 py-2 font-medium text-white disabled:opacity-60">
            {busy ? "Joining…" : `Join ${invite.graphName}`}
          </button>
        ) : (
          <p className="text-sm text-muted">
            This invite is for {invite.email}, but you are signed in as {signedInAs.email}.{" "}
            <a className="text-accent underline" href={`/login?next=${encodeURIComponent(next)}`}>Sign in as {invite.email}</a>.
          </p>
        )}
        {error ? <p role="alert" className="text-sm text-red-600">{error}</p> : null}
      </div>
    );
  }

  if (invite.hasAccount) {
    return (
      <p className="mt-6 text-sm">
        You already have an account for {invite.email}.{" "}
        <a className="text-accent underline" href={`/login?next=${encodeURIComponent(next)}`}>Sign in</a> and come back to this link to join.
      </p>
    );
  }

  return (
    <form className="mt-6 space-y-3" onSubmit={(e) => { e.preventDefault(); void accept({ name, password }); }}>
      <p className="text-sm text-muted">Make your account for {invite.email}. It is yours alone: nobody in {invite.inviterName}&apos;s household can see your other graphs.</p>
      <label className="block text-sm">
        <span className="font-medium">Your name</span>
        <input className="mt-1 w-full rounded-lg border border-line bg-transparent px-3 py-2" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required maxLength={80} />
      </label>
      <label className="block text-sm">
        <span className="font-medium">Choose a password</span>
        <input className="mt-1 w-full rounded-lg border border-line bg-transparent px-3 py-2" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required minLength={10} />
      </label>
      <button type="submit" disabled={busy} className="w-full rounded-lg bg-accent px-4 py-2 font-medium text-white disabled:opacity-60">
        {busy ? "Making your account…" : `Make my account and join ${invite.graphName}`}
      </button>
      {error ? <p role="alert" className="text-sm text-red-600">{error}</p> : null}
    </form>
  );
}
