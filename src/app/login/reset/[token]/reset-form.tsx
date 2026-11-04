"use client";
import Link from "next/link";
import { useState } from "react";
import { Button, Field, Input, buttonClass } from "@/components/ui";
import { useT } from "@/lib/i18n/client";
import { resetPassword } from "./actions";

export function ResetForm({ token, minLength }: { token: string; minLength: number }) {
  const t = useT();
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password !== again) { setError(t("settings.resetLink.mismatch")); return; }
    setBusy(true);
    try {
      const r = await resetPassword({ token, password });
      if (r.ok) setDone(true);
      else setError(r.error);
    } catch {
      setError(t("settings.resetLink.failed"));
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div role="status">
        <p>{t("settings.resetLink.done")}</p>
        <Link href="/login" className={buttonClass("primary") + " mt-6"}>{t("settings.resetLink.toSignIn")}</Link>
      </div>
    );
  }
  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <Field label={t("settings.resetLink.newPassword")} hint={t("settings.resetLink.hint", { min: minLength })}>
        <Input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={minLength} autoFocus />
      </Field>
      <Field label={t("settings.resetLink.again")}>
        <Input type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} required />
      </Field>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      <Button type="submit" disabled={busy} className="w-full">{busy ? t("settings.resetLink.saving") : t("settings.resetLink.save")}</Button>
    </form>
  );
}
