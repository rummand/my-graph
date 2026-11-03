"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Input } from "@/components/ui";
import { api, errorFields, errorMessage, type FieldErrors } from "@/lib/auth/client/api";
import { describedBy, Field, FormError } from "@/lib/auth/client/field";

export function SetupForm() {
  const router = useRouter();
  const [f, setF] = useState({ householdName: "", name: "", email: "", password: "", confirm: "" });
  const [fields, setFields] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const errs: FieldErrors = {};
    if (!f.householdName.trim()) errs.householdName = "Give your household a name.";
    if (!f.name.trim()) errs.name = "Enter your name.";
    if (!f.email.trim()) errs.email = "Enter your email address.";
    if (f.password.length < 10) errs.password = "Use at least 10 characters.";
    if (f.password !== f.confirm) errs.confirm = "The two passwords don't match.";
    setFields(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      await api("/api/auth/setup", { json: { householdName: f.householdName, name: f.name, email: f.email, password: f.password } });
      router.replace("/settings/family?welcome=1");
      router.refresh();
    } catch (err) {
      setFields(errorFields(err));
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  const input = (k: keyof typeof f, props: React.InputHTMLAttributes<HTMLInputElement>, hint?: boolean) => (
    <Input id={`setup-${k}`} name={k} value={f[k]} onChange={set(k)} aria-invalid={!!fields[k] || undefined}
      aria-describedby={describedBy(`setup-${k}`, fields[k], hint)} {...props} />
  );

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <Field id="setup-householdName" label="Household name" error={fields.householdName} hint="For example “The Jensens” or “Home”.">
        {input("householdName", { autoFocus: true, maxLength: 80 }, true)}
      </Field>
      <Field id="setup-name" label="Your name" error={fields.name}>
        {input("name", { autoComplete: "name", maxLength: 80 })}
      </Field>
      <Field id="setup-email" label="Your email" error={fields.email}>
        {input("email", { type: "email", autoComplete: "email", autoCapitalize: "none", spellCheck: false })}
      </Field>
      <Field id="setup-password" label="Password" error={fields.password} hint="At least 10 characters. A short sentence works well.">
        {input("password", { type: "password", autoComplete: "new-password" }, true)}
      </Field>
      <Field id="setup-confirm" label="Password again" error={fields.confirm}>
        {input("confirm", { type: "password", autoComplete: "new-password" })}
      </Field>
      <FormError message={error} />
      <Button type="submit" className="w-full" disabled={busy}>{busy ? "Setting up…" : "Create household"}</Button>
    </form>
  );
}
