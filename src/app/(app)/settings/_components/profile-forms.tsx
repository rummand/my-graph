"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Avatar, Button, Input, PersonChip } from "@/components/ui";
import { useT } from "@/lib/i18n/client";
import { api, errorFields, errorMessage, type FieldErrors } from "@/lib/auth/client/api";
import { describedBy, Field } from "@/lib/auth/client/field";
import { ErrorNote, Notice } from "@/app/login/notes";
import { PanelFooter, Row } from "./section";

export function ProfileForm({ name: initialName, email: initialEmail, personId }: { name: string; email: string; personId: string }) {
  const router = useRouter();
  const t = useT();
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
      setSaved(t("common.saved"));
      router.refresh();
    } catch (err) {
      setFields(errorFields(err)); setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Row id="profile-name" title={t("settings.profile.title")} lead={t("settings.profile.lead")}
      asideFirst aside={
        <div className="flex items-center gap-3">
          <Avatar id={personId} name={name.trim() || t("settings.profile.yourName")} size={40} />
          <div className="min-w-0">
            <p className="text-sm font-medium">{t("settings.profile.colour")}</p>
            <PersonChip id={personId} name={name.trim() || t("settings.profile.yourName")} className="mt-1" />
          </div>
        </div>
      }>
      <form onSubmit={submit} noValidate>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="pf-name" label={t("settings.profile.name")} error={fields.name}>
            <Input id="pf-name" value={name} onChange={(e) => { setName(e.target.value); setSaved(null); }} autoComplete="name" maxLength={80}
              aria-invalid={!!fields.name || undefined} aria-describedby={describedBy("pf-name", fields.name)} />
          </Field>
          <Field id="pf-email" label={t("settings.profile.email")} error={fields.email} hint={t("settings.profile.emailHint")}>
            <Input id="pf-email" value={email} onChange={(e) => { setEmail(e.target.value); setSaved(null); }} autoComplete="email" autoCapitalize="none" spellCheck={false}
              aria-invalid={!!fields.email || undefined} aria-describedby={describedBy("pf-email", fields.email, true)} />
          </Field>
        </div>
        <ErrorNote message={error} className="mt-4" />
        <PanelFooter status={<Notice message={saved} />}>
          <Button type="submit" disabled={busy || !dirty}>{busy ? t("common.saving") : t("common.save")}</Button>
        </PanelFooter>
      </form>
    </Row>
  );
}

export function PasswordForm({ hasPassword }: { hasPassword: boolean }) {
  const router = useRouter();
  const t = useT();
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
    if (hasPassword && !current) errs.currentPassword = t("settings.password.errCurrent");
    if (next.length < 10) errs.newPassword = t("settings.password.errShort");
    if (next !== confirm) errs.confirm = t("settings.password.errMatch");
    setFields(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      const r = await api<{ signedOut: number }>("/api/auth/password", { json: { currentPassword: hasPassword ? current : undefined, newPassword: next, signOutOthers } });
      setCurrent(""); setNext(""); setConfirm("");
      setSaved(r.signedOut ? t("settings.password.changedSignedOut", { count: r.signedOut }) : t("settings.password.changed"));
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
            <Field id="pw-current" label={t("settings.password.current")} error={fields.currentPassword}>
              <Input id="pw-current" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)}
                aria-invalid={!!fields.currentPassword || undefined} aria-describedby={describedBy("pw-current", fields.currentPassword)} />
            </Field>
          </div>
        )}
        <Field id="pw-new" label={t("settings.password.new")} error={fields.newPassword} hint={t("settings.password.newHint")}>
          <Input id="pw-new" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)}
            aria-invalid={!!fields.newPassword || undefined} aria-describedby={describedBy("pw-new", fields.newPassword, true)} />
        </Field>
        <Field id="pw-confirm" label={t("settings.password.again")} error={fields.confirm}>
          <Input id="pw-confirm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)}
            aria-invalid={!!fields.confirm || undefined} aria-describedby={describedBy("pw-confirm", fields.confirm)} />
        </Field>
      </div>
      <label className="mt-4 flex w-fit cursor-pointer items-center gap-2.5 text-sm">
        <input type="checkbox" checked={signOutOthers} onChange={(e) => setSignOutOthers(e.target.checked)} className="size-4 accent-[var(--fg)]" />
        {t("settings.password.signOutOthers")}
      </label>
      <ErrorNote message={error} className="mt-4" />
      <PanelFooter status={<Notice message={saved} />}>
        <Button type="submit" variant="secondary" disabled={busy}>{busy ? t("common.saving") : hasPassword ? t("settings.password.change") : t("settings.password.add")}</Button>
      </PanelFooter>
    </form>
  );
}
