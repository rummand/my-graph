"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Input, PersonChip } from "@/components/ui";
import { api, errorFields, errorMessage, type FieldErrors } from "@/lib/auth/client/api";
import { describedBy, Field } from "@/lib/auth/client/field";
import { ErrorNote, Notice } from "@/app/login/notes";
import { PanelFooter, Row } from "./section";

export function ProfileForm({ name: initialName, email: initialEmail, personId }: { name: string; email: string; personId: string }) {
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
    <Row id="profile" title="Your name"
      lead="This is how you appear to the family: in answers, on the timeline and next to everything you add."
      asideFirst aside={<PersonChip id={personId} name={name.trim() || "Your name"} />}>
      <form onSubmit={submit} noValidate>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="pf-name" label="Name" error={fields.name}>
            <Input id="pf-name" value={name} onChange={(e) => { setName(e.target.value); setSaved(null); }} autoComplete="name" maxLength={80}
              aria-invalid={!!fields.name || undefined} aria-describedby={describedBy("pf-name", fields.name)} />
          </Field>
          <Field id="pf-email" label="Email or username" error={fields.email} hint="What you type when you sign in.">
            <Input id="pf-email" value={email} onChange={(e) => { setEmail(e.target.value); setSaved(null); }} autoComplete="email" autoCapitalize="none" spellCheck={false}
              aria-invalid={!!fields.email || undefined} aria-describedby={describedBy("pf-email", fields.email, true)} />
          </Field>
        </div>
        <ErrorNote message={error} className="mt-4" />
        <PanelFooter status={<Notice message={saved} />}>
          <Button type="submit" disabled={busy || !dirty}>{busy ? "Saving…" : "Save"}</Button>
        </PanelFooter>
      </form>
    </Row>
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
    <form onSubmit={submit} noValidate>
      <div className="grid gap-4 sm:grid-cols-2">
        {hasPassword && (
          <div className="sm:col-span-2 sm:max-w-[calc(50%-0.5rem)]">
            <Field id="pw-current" label="Current password" error={fields.currentPassword}>
              <Input id="pw-current" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)}
                aria-invalid={!!fields.currentPassword || undefined} aria-describedby={describedBy("pw-current", fields.currentPassword)} />
            </Field>
          </div>
        )}
        <Field id="pw-new" label="New password" error={fields.newPassword} hint="At least 10 characters. A short sentence works well.">
          <Input id="pw-new" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)}
            aria-invalid={!!fields.newPassword || undefined} aria-describedby={describedBy("pw-new", fields.newPassword, true)} />
        </Field>
        <Field id="pw-confirm" label="New password again" error={fields.confirm}>
          <Input id="pw-confirm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)}
            aria-invalid={!!fields.confirm || undefined} aria-describedby={describedBy("pw-confirm", fields.confirm)} />
        </Field>
      </div>
      <label className="mt-4 flex w-fit cursor-pointer items-center gap-2.5 text-sm">
        <input type="checkbox" checked={signOutOthers} onChange={(e) => setSignOutOthers(e.target.checked)} className="size-4 accent-[var(--fg)]" />
        Sign me out on my other devices
      </label>
      <ErrorNote message={error} className="mt-4" />
      <PanelFooter status={<Notice message={saved} />}>
        <Button type="submit" variant="secondary" disabled={busy}>{busy ? "Saving…" : hasPassword ? "Change password" : "Add password"}</Button>
      </PanelFooter>
    </form>
  );
}
