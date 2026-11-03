"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Input } from "@/components/ui";
import { api, errorFields, errorMessage, type FieldErrors } from "@/lib/auth/client/api";
import { describedBy, Field, FormError, FormNotice } from "@/lib/auth/client/field";

export function ProfileForm({ name: initialName, email: initialEmail }: { name: string; email: string }) {
  const router = useRouter();
  const [name, setName] = useState(initialName);
  const [email, setEmail] = useState(initialEmail);
  const [fields, setFields] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dirty = name !== initialName || email !== initialEmail;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null); setSaved(null); setFields({});
    setBusy(true);
    try {
      await api("/api/auth/profile", { method: "PATCH", json: { name, email } });
      setSaved("Saved.");
      router.refresh();
    } catch (err) {
      setFields(errorFields(err)); setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2" noValidate>
      <Field id="pf-name" label="Name" error={fields.name}>
        <Input id="pf-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" maxLength={80}
          aria-invalid={!!fields.name || undefined} aria-describedby={describedBy("pf-name", fields.name)} />
      </Field>
      <Field id="pf-email" label="Email or username" error={fields.email} hint="What you type when you sign in.">
        <Input id="pf-email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" autoCapitalize="none" spellCheck={false}
          aria-invalid={!!fields.email || undefined} aria-describedby={describedBy("pf-email", fields.email, true)} />
      </Field>
      <div className="space-y-3 sm:col-span-2">
        <FormError message={error} />
        <FormNotice message={saved} />
        <Button type="submit" disabled={busy || !dirty}>{busy ? "Saving…" : "Save profile"}</Button>
      </div>
    </form>
  );
}

export function PasswordForm({ hasPassword }: { hasPassword: boolean }) {
  const router = useRouter();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [signOutOthers, setSignOutOthers] = useState(true);
  const [fields, setFields] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null); setSaved(null);
    const errs: FieldErrors = {};
    if (hasPassword && !current) errs.currentPassword = "Enter your current password.";
    if (next.length < 10) errs.newPassword = "Use at least 10 characters.";
    if (next !== confirm) errs.confirm = "The two passwords don't match.";
    setFields(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      const r = await api<{ signedOut: number }>("/api/auth/password", { json: { currentPassword: hasPassword ? current : undefined, newPassword: next, signOutOthers } });
      setCurrent(""); setNext(""); setConfirm("");
      setSaved(r.signedOut ? `Password changed. Signed out ${r.signedOut} other device${r.signedOut === 1 ? "" : "s"}.` : "Password changed.");
      router.refresh();
    } catch (err) {
      setFields(errorFields(err)); setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2" noValidate>
      {hasPassword && (
        <div className="sm:col-span-2 sm:max-w-[calc(50%-0.5rem)]">
          <Field id="pw-current" label="Current password" error={fields.currentPassword}>
            <Input id="pw-current" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)}
              aria-invalid={!!fields.currentPassword || undefined} aria-describedby={describedBy("pw-current", fields.currentPassword)} />
          </Field>
        </div>
      )}
      <Field id="pw-new" label="New password" error={fields.newPassword} hint="At least 10 characters.">
        <Input id="pw-new" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)}
          aria-invalid={!!fields.newPassword || undefined} aria-describedby={describedBy("pw-new", fields.newPassword, true)} />
      </Field>
      <Field id="pw-confirm" label="New password again" error={fields.confirm}>
        <Input id="pw-confirm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)}
          aria-invalid={!!fields.confirm || undefined} aria-describedby={describedBy("pw-confirm", fields.confirm)} />
      </Field>
      <label className="flex items-center gap-2 text-sm sm:col-span-2">
        <input type="checkbox" checked={signOutOthers} onChange={(e) => setSignOutOthers(e.target.checked)} className="h-4 w-4 accent-[var(--accent)]" />
        Sign out my other devices
      </label>
      <div className="space-y-3 sm:col-span-2">
        <FormError message={error} />
        <FormNotice message={saved} />
        <Button type="submit" disabled={busy}>{busy ? "Saving…" : hasPassword ? "Change password" : "Set password"}</Button>
      </div>
    </form>
  );
}
