"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { clsx } from "clsx";
import { Button, Input } from "@/components/ui";
import { api, errorFields, errorMessage, type FieldErrors } from "@/lib/auth/client/api";
import { describedBy, Field } from "@/lib/auth/client/field";
import { ErrorNote, Notice } from "@/app/login/notes";
import { PanelFooter, Row } from "./section";

type Role = "parent" | "child" | "guest";

const ROLE_NAME: Record<Role, string> = { parent: "Parent", child: "Child", guest: "Guest" };
const ROLE_HELP: Record<Role, string> = {
  parent: "Sees everything shared with parents and can manage the family.",
  child: "Sees what's shared with the household. New devices need a parent's approval.",
  guest: "A grandparent or babysitter. Sees only what you share with them, until the date you choose.",
};

function inDays(n: number) {
  const d = new Date(Date.now() + n * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** What the parent will tell the new person: shown as they type, so the result of the form is visible. */
function HandOff({ name, login, origin }: { name: string; login: string; origin: string }) {
  const who = name.trim() || "them";
  return (
    <div className="rounded-lg bg-surface-2/70 p-4 text-sm">
      <p className="font-medium">What to tell {who}</p>
      <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
        <dt className="text-muted">Go to</dt><dd className="truncate">{origin ? `${origin.replace(/^https?:\/\//, "")}/login` : "this site"}</dd>
        <dt className="text-muted">Sign in as</dt><dd className="truncate font-medium">{login.trim().toLowerCase() || <span className="font-normal text-muted">their username</span>}</dd>
        <dt className="text-muted">Password</dt><dd>the one you choose here</dd>
      </dl>
    </div>
  );
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
  const [origin, setOrigin] = useState("");
  const year = new Date().getFullYear();

  useEffect(() => setOrigin(window.location.origin), []);

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
    <Row id="add" title="Add someone"
      lead="They sign in with the username and password you set here, and can change the password afterwards."
      aside={<HandOff name={name} login={email} origin={origin} />}>
      <form onSubmit={submit} noValidate>
        <fieldset>
          <legend className="mb-1.5 text-sm font-medium">They are a</legend>
          <div className="inline-flex rounded-md bg-surface-2 p-0.5">
            {roles.map((r) => (
              <label key={r} className={clsx("relative inline-flex h-8 cursor-pointer items-center rounded-[5px] px-4 text-sm transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent",
                role === r ? "bg-surface font-medium text-fg shadow-[0_1px_2px_rgb(0_0_0/0.08)]" : "text-muted hover:text-fg")}>
                <input type="radio" name="role" value={r} checked={role === r} onChange={() => setRole(r)} className="sr-only" />
                {ROLE_NAME[r]}
              </label>
            ))}
          </div>
          <p className="mt-2 text-sm text-muted">{ROLE_HELP[role]}</p>
        </fieldset>
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <Field id="am-name" label="Name" error={fields.name}>
            <Input id="am-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoComplete="off"
              aria-invalid={!!fields.name || undefined} aria-describedby={describedBy("am-name", fields.name)} />
          </Field>
          <Field id="am-email" label="Email or username" error={fields.email} hint={role === "child" ? "Children can have a simple username, like “emma”." : undefined}>
            <Input id="am-email" value={email} onChange={(e) => setEmail(e.target.value)} autoCapitalize="none" spellCheck={false} autoComplete="off"
              aria-invalid={!!fields.email || undefined} aria-describedby={describedBy("am-email", fields.email, role === "child")} />
          </Field>
          <Field id="am-password" label="Starting password" error={fields.password} hint="At least 10 characters. They can change it later.">
            <Input id="am-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password"
              aria-invalid={!!fields.password || undefined} aria-describedby={describedBy("am-password", fields.password, true)} />
          </Field>
          {role === "child" && (
            <Field id="am-birthYear" label="Birth year" error={fields.birthYear}>
              <Input id="am-birthYear" inputMode="numeric" pattern="[0-9]*" maxLength={4} placeholder={String(year - 8)} value={birthYear}
                onChange={(e) => setBirthYear(e.target.value.replace(/\D/g, ""))} className="tabular-nums"
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
        <ErrorNote message={error} className="mt-4" />
        <PanelFooter status={<Notice message={notice} />}>
          <Button type="submit" disabled={busy}>{busy ? "Adding…" : `Add ${name.trim() ? name.trim().split(/\s+/)[0] : "to family"}`}</Button>
        </PanelFooter>
      </form>
    </Row>
  );
}
