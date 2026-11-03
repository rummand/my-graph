"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Input } from "@/components/ui";
import { api, errorFields, errorMessage, type FieldErrors } from "@/lib/auth/client/api";
import { describedBy, Field, FormError, FormNotice } from "@/lib/auth/client/field";

type Role = "parent" | "child" | "guest";

const ROLE_HELP: Record<Role, string> = {
  parent: "Sees everything shared with parents and can manage the family.",
  child: "Sees what's shared with the household. New devices need a parent's approval.",
  guest: "A grandparent or babysitter: sees only what you share with them, until the date you choose.",
};

function inDays(n: number) {
  const d = new Date(Date.now() + n * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function AddMemberForm({ canAddParent }: { canAddParent: boolean }) {
  const router = useRouter();
  const roles: Role[] = canAddParent ? ["parent", "child", "guest"] : ["child", "guest"];
  const [role, setRole] = useState<Role>("child");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [birthYear, setBirthYear] = useState("");
  const [until, setUntil] = useState(inDays(14));
  const [fields, setFields] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const year = new Date().getFullYear();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null); setNotice(null);
    const errs: FieldErrors = {};
    if (!name.trim()) errs.name = "Enter their name.";
    if (!email.trim()) errs.email = "Enter an email address or a username.";
    if (password.length < 10) errs.password = "Use at least 10 characters.";
    if (role === "child" && !/^\d{4}$/.test(birthYear)) errs.birthYear = "Enter the year they were born, like 2016.";
    if (role === "guest" && !until) errs.accessExpiresAt = "Choose when their access ends.";
    setFields(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      await api("/api/auth/members", {
        json: {
          role, name, email, password,
          birthYear: role === "child" ? Number(birthYear) : null,
          accessExpiresAt: role === "guest" ? new Date(`${until}T23:59:59`).toISOString() : null,
        },
      });
      setNotice(`${name.trim()} is added. Tell them their username (${email.trim().toLowerCase()}) and password.`);
      setName(""); setEmail(""); setPassword(""); setBirthYear("");
      router.refresh();
    } catch (err) {
      setFields(errorFields(err)); setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <fieldset>
        <legend className="mb-2 text-sm font-medium">They are a…</legend>
        <div className="grid gap-2 sm:grid-cols-3">
          {roles.map((r) => (
            <label key={r} className={`cursor-pointer rounded-md border p-3 text-sm ${role === r ? "border-accent bg-accent-tint" : "border-line hover:bg-surface-2"}`}>
              <span className="flex items-center gap-2 font-medium">
                <input type="radio" name="role" value={r} checked={role === r} onChange={() => setRole(r)} className="accent-[var(--accent)]" />
                {r === "parent" ? "Parent" : r === "child" ? "Child" : "Guest"}
              </span>
              <span className="mt-1 block text-xs text-muted">{ROLE_HELP[r]}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="am-name" label="Name" error={fields.name}>
          <Input id="am-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoComplete="off"
            aria-invalid={!!fields.name || undefined} aria-describedby={describedBy("am-name", fields.name)} />
        </Field>
        <Field id="am-email" label="Email or username" error={fields.email} hint={role === "child" ? "Children can have a simple username, like “emma”." : undefined}>
          <Input id="am-email" value={email} onChange={(e) => setEmail(e.target.value)} autoCapitalize="none" spellCheck={false} autoComplete="off"
            aria-invalid={!!fields.email || undefined} aria-describedby={describedBy("am-email", fields.email, role === "child")} />
        </Field>
        <Field id="am-password" label="Starting password" error={fields.password} hint="At least 10 characters. They can change it in Settings.">
          <Input id="am-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password"
            aria-invalid={!!fields.password || undefined} aria-describedby={describedBy("am-password", fields.password, true)} />
        </Field>
        {role === "child" && (
          <Field id="am-birthYear" label="Birth year" error={fields.birthYear}>
            <Input id="am-birthYear" inputMode="numeric" pattern="[0-9]*" maxLength={4} placeholder={String(year - 8)} value={birthYear}
              onChange={(e) => setBirthYear(e.target.value.replace(/\D/g, ""))}
              aria-invalid={!!fields.birthYear || undefined} aria-describedby={describedBy("am-birthYear", fields.birthYear)} />
          </Field>
        )}
        {role === "guest" && (
          <Field id="am-accessExpiresAt" label="Access until" error={fields.accessExpiresAt} hint="They can't sign in after the end of this day.">
            <Input id="am-accessExpiresAt" type="date" min={inDays(0)} value={until} onChange={(e) => setUntil(e.target.value)}
              aria-invalid={!!fields.accessExpiresAt || undefined} aria-describedby={describedBy("am-accessExpiresAt", fields.accessExpiresAt, true)} />
          </Field>
        )}
      </div>
      <FormError message={error} />
      <FormNotice message={notice} />
      <Button type="submit" disabled={busy}>{busy ? "Adding…" : "Add to family"}</Button>
    </form>
  );
}
