"use client";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { clsx } from "clsx";
import { Button, Field, Input, Select, buttonClass } from "@/components/ui";
import { useFormatDate } from "@/lib/i18n/client";
import { Secret } from "./account-controls";

/** Strings translated on the server (admin copy never goes into the client dictionary). */
export type NewAccountCopy = Record<
  | "title" | "lead" | "name" | "email" | "household" | "householdHint" | "householdPlaceholder" | "graph" | "graphFamily"
  | "graphFamilyHint" | "graphPersonal" | "graphPersonalHint" | "plan" | "access" | "accessLink" | "accessLinkHint" | "accessTemp"
  | "accessTempHint" | "create" | "creating" | "doneTitle" | "doneLink" | "donePassword" | "copy" | "copied" | "openAccount"
  | "another" | "failed",
  string
>;

type Done = { id: string; name: string; url?: string; expiresAt?: string; password?: string };

export function NewAccountForm({ plans, defaultPlan, copy: c }: { plans: { key: string; name: string }[]; defaultPlan: string; copy: NewAccountCopy }) {
  const fmt = useFormatDate();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [householdName, setHouseholdName] = useState("");
  const [firstGraph, setFirstGraph] = useState<"family" | "personal">("family");
  const [plan, setPlan] = useState(defaultPlan);
  const [access, setAccess] = useState<"link" | "temp">("link");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/accounts", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, email, householdName: householdName.trim() || undefined, firstGraph, plan: plan || undefined, access }),
      });
      const r = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) throw new Error(typeof r.error === "string" ? r.error : c.failed);
      setDone({
        id: String(r.id), name: name.trim(),
        url: typeof r.url === "string" ? r.url : undefined,
        expiresAt: typeof r.expiresAt === "string" ? r.expiresAt : undefined,
        password: typeof r.password === "string" ? r.password : undefined,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : c.failed);
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setDone(null); setName(""); setEmail(""); setHouseholdName(""); setFirstGraph("family"); setPlan(defaultPlan); setAccess("link");
  }

  if (done) {
    return (
      <section className="max-w-2xl rounded-lg bg-surface p-5" aria-live="polite">
        <h2 className="text-lg font-semibold">{c.doneTitle.replace("{name}", done.name)}</h2>
        {done.url && <Secret value={done.url} copy={c.copy} copied={c.copied} mono={false}
          text={c.doneLink.replace("{date}", done.expiresAt ? fmt(done.expiresAt, "dateTime") : "")} />}
        {done.password && <Secret value={done.password} text={c.donePassword} copy={c.copy} copied={c.copied} mono />}
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <Link href={`/admin/accounts/${done.id}`} className={buttonClass("primary")}>{c.openAccount}</Link>
          <Button variant="secondary" onClick={reset}>{c.another}</Button>
        </div>
      </section>
    );
  }

  const placeholder = name.trim() ? `${name.trim()}'s home` : c.householdPlaceholder;
  return (
    <form onSubmit={submit} className="max-w-2xl space-y-6 rounded-lg bg-surface p-5">
      <div>
        <h2 className="text-lg font-semibold">{c.title}</h2>
        <p className="mt-1 max-w-[60ch] text-sm text-muted">{c.lead}</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={c.name}>
          <Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} autoComplete="off" autoFocus />
        </Field>
        <Field label={c.email}>
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required maxLength={254} autoComplete="off" spellCheck={false} />
        </Field>
        <Field label={c.household} hint={c.householdHint.replace("{example}", placeholder)}>
          <Input value={householdName} onChange={(e) => setHouseholdName(e.target.value)} maxLength={80} placeholder={placeholder} autoComplete="off" />
        </Field>
        <Field label={c.plan}>
          <Select value={plan} onChange={(e) => setPlan(e.target.value)}>
            {plans.map((p) => <option key={p.key} value={p.key}>{p.name}</option>)}
          </Select>
        </Field>
      </div>

      <Choice legend={c.graph}>
        <Option name="firstGraph" checked={firstGraph === "family"} onChange={() => setFirstGraph("family")} label={c.graphFamily} hint={c.graphFamilyHint} />
        <Option name="firstGraph" checked={firstGraph === "personal"} onChange={() => setFirstGraph("personal")} label={c.graphPersonal} hint={c.graphPersonalHint} />
      </Choice>

      <Choice legend={c.access}>
        <Option name="access" checked={access === "link"} onChange={() => setAccess("link")} label={c.accessLink} hint={c.accessLinkHint} />
        <Option name="access" checked={access === "temp"} onChange={() => setAccess("temp")} label={c.accessTemp} hint={c.accessTempHint} />
      </Choice>

      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      <Button type="submit" disabled={busy}>{busy ? c.creating : c.create}</Button>
    </form>
  );
}

function Choice({ legend, children }: { legend: string; children: ReactNode }) {
  return (
    <fieldset>
      <legend className="mb-2 text-sm font-medium">{legend}</legend>
      <div className="grid gap-2 sm:grid-cols-2">{children}</div>
    </fieldset>
  );
}

function Option({ name, checked, onChange, label, hint }: { name: string; checked: boolean; onChange: () => void; label: string; hint: string }) {
  return (
    <label className={clsx("flex cursor-pointer gap-3 rounded-md p-3 ring-1 ring-inset transition-colors",
      checked ? "bg-accent-tint ring-accent" : "ring-line hover:bg-surface-2")}>
      <input type="radio" name={name} checked={checked} onChange={onChange} className="mt-1 accent-[var(--color-accent)]" />
      <span className="min-w-0">
        <span className="block text-sm font-medium">{label}</span>
        <span className="block text-sm text-muted">{hint}</span>
      </span>
    </label>
  );
}
