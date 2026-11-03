"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Input } from "@/components/ui";
import { api, errorFields, errorMessage, type FieldErrors } from "@/lib/auth/client/api";
import { describedBy, Field, FormError, FormNotice } from "@/lib/auth/client/field";
import { roleLabel } from "@/lib/auth/audit-labels";
import type { MemberView } from "@/lib/auth/settings-data";
import { fmtDate } from "./format";
import { Badge } from "./section";
import { SessionList } from "./session-list";

const ymd = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export function MemberList({ members, viewerRole }: { members: MemberView[]; viewerRole: string }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <ul className="divide-y divide-line rounded-md border border-line">
      {members.map((m) => {
        const expired = m.role === "guest" && (!m.accessExpiresAt || new Date(m.accessExpiresAt) <= new Date());
        const age = m.birthYear ? new Date().getFullYear() - m.birthYear : null;
        return (
          <li key={m.id} className="px-3 py-3">
            <div className="flex flex-wrap items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  {m.personNodeId ? <Link href={`/people/${m.personNodeId}`} className="hover:underline">{m.name}</Link> : m.name}
                  <Badge tone={m.role === "owner" || m.role === "parent" ? "accent" : "muted"}>{roleLabel(m.role)}</Badge>
                  {m.isYou && <Badge>You</Badge>}
                  {!m.canSignIn && <Badge tone="warn">Can&apos;t sign in</Badge>}
                  {m.role === "guest" && (expired ? <Badge tone="danger">Access ended</Badge> : m.accessExpiresAt && <Badge>Until {fmtDate(m.accessExpiresAt)}</Badge>)}
                </p>
                <p className="truncate text-xs text-muted">
                  {m.email}
                  {age !== null && ` · born ${m.birthYear} (about ${age})`}
                  {` · ${m.sessions.length ? `signed in on ${m.sessions.length} device${m.sessions.length === 1 ? "" : "s"}` : "not signed in"}`}
                  {m.passkeyCount > 0 && ` · ${m.passkeyCount} passkey${m.passkeyCount === 1 ? "" : "s"}`}
                </p>
              </div>
              {m.canManage && (
                <Button variant="secondary" onClick={() => setOpen(open === m.id ? null : m.id)} aria-expanded={open === m.id} aria-controls={`member-${m.id}`}>
                  {open === m.id ? "Close" : "Manage"}
                </Button>
              )}
            </div>
            {open === m.id && m.canManage && (
              <div id={`member-${m.id}`} className="mt-4 border-t border-line pt-4">
                <MemberEditor member={m} canChangeRole={viewerRole === "owner"} onClose={() => setOpen(null)} />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function MemberEditor({ member: m, canChangeRole, onClose }: { member: MemberView; canChangeRole: boolean; onClose: () => void }) {
  const router = useRouter();
  const [name, setName] = useState(m.name);
  const [email, setEmail] = useState(m.email);
  const [role, setRole] = useState(m.role);
  const [birthYear, setBirthYear] = useState(m.birthYear ? String(m.birthYear) : "");
  const [until, setUntil] = useState(m.accessExpiresAt ? ymd(m.accessExpiresAt) : "");
  const [password, setPassword] = useState("");
  const [fields, setFields] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function run(key: string, fn: () => Promise<unknown>, ok: string, after?: () => void) {
    setBusy(key); setError(null); setNotice(null); setFields({});
    try {
      await fn();
      setNotice(ok);
      after?.();
      router.refresh();
    } catch (e) {
      setFields(errorFields(e)); setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  function save(e: React.FormEvent) {
    e.preventDefault();
    const body: Record<string, unknown> = {};
    if (name !== m.name) body.name = name;
    if (email !== m.email) body.email = email;
    if (role !== m.role) body.role = role;
    const by = birthYear ? Number(birthYear) : null;
    if (by !== m.birthYear) body.birthYear = by;
    if (role === "guest") {
      const iso = until ? new Date(`${until}T23:59:59`).toISOString() : null;
      if (iso !== m.accessExpiresAt) body.accessExpiresAt = iso;
    }
    if (!Object.keys(body).length) { setNotice("Nothing changed."); return; }
    run("save", () => api(`/api/auth/members/${m.id}`, { method: "PATCH", json: body }), "Saved.");
  }

  const roleOptions = canChangeRole ? ["parent", "child", "guest"] : ["child", "guest"];

  return (
    <div className="space-y-6">
      <form onSubmit={save} className="grid gap-4 sm:grid-cols-2" noValidate>
        <Field id={`me-name-${m.id}`} label="Name" error={fields.name}>
          <Input id={`me-name-${m.id}`} value={name} onChange={(e) => setName(e.target.value)} maxLength={80}
            aria-invalid={!!fields.name || undefined} aria-describedby={describedBy(`me-name-${m.id}`, fields.name)} />
        </Field>
        <Field id={`me-email-${m.id}`} label="Email or username" error={fields.email}>
          <Input id={`me-email-${m.id}`} value={email} onChange={(e) => setEmail(e.target.value)} autoCapitalize="none" spellCheck={false}
            aria-invalid={!!fields.email || undefined} aria-describedby={describedBy(`me-email-${m.id}`, fields.email)} />
        </Field>
        <Field id={`me-role-${m.id}`} label="Role">
          <select id={`me-role-${m.id}`} value={role} onChange={(e) => setRole(e.target.value as MemberView["role"])}
            className="w-full rounded-md border border-line bg-surface px-3 py-2 text-sm">
            {roleOptions.map((r) => <option key={r} value={r}>{roleLabel(r)}</option>)}
          </select>
        </Field>
        {role === "child" && (
          <Field id={`me-by-${m.id}`} label="Birth year" error={fields.birthYear}>
            <Input id={`me-by-${m.id}`} inputMode="numeric" maxLength={4} value={birthYear} onChange={(e) => setBirthYear(e.target.value.replace(/\D/g, ""))}
              aria-invalid={!!fields.birthYear || undefined} aria-describedby={describedBy(`me-by-${m.id}`, fields.birthYear)} />
          </Field>
        )}
        {role === "guest" && (
          <Field id={`me-until-${m.id}`} label="Access until" error={fields.accessExpiresAt}>
            <Input id={`me-until-${m.id}`} type="date" value={until} onChange={(e) => setUntil(e.target.value)}
              aria-invalid={!!fields.accessExpiresAt || undefined} aria-describedby={describedBy(`me-until-${m.id}`, fields.accessExpiresAt)} />
          </Field>
        )}
        <div className="sm:col-span-2">
          <Button type="submit" disabled={busy !== null}>{busy === "save" ? "Saving…" : "Save changes"}</Button>
        </div>
      </form>

      <form className="flex flex-wrap items-end gap-2" noValidate
        onSubmit={(e) => { e.preventDefault(); run("pw", () => api(`/api/auth/members/${m.id}`, { method: "PATCH", json: { password } }), `New password set. ${m.name} is signed out everywhere.`, () => setPassword("")); }}>
        <div className="min-w-0 flex-1 basis-56">
          <Field id={`me-pw-${m.id}`} label="Set a new password" error={fields.password}>
            <Input id={`me-pw-${m.id}`} type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)}
              aria-invalid={!!fields.password || undefined} aria-describedby={describedBy(`me-pw-${m.id}`, fields.password)} />
          </Field>
        </div>
        <Button type="submit" variant="secondary" disabled={busy !== null || password.length === 0}>{busy === "pw" ? "Setting…" : "Set password"}</Button>
      </form>

      <div>
        <h3 className="mb-2 text-sm font-medium">{m.name}&apos;s devices</h3>
        <SessionList sessions={m.sessions} allowSignOutOthers={false} />
      </div>

      <FormError message={error} />
      <FormNotice message={notice} />

      <div className="flex flex-wrap gap-2 border-t border-line pt-4">
        {m.canSignIn && (
          <Button variant="secondary" disabled={busy !== null}
            onClick={() => { if (confirm(`Turn off sign-in for ${m.name}? Their password and passkeys stop working and they're signed out everywhere. Their brain stays, and you can set a new password later.`)) run("disable", () => api(`/api/auth/members/${m.id}`, { method: "PATCH", json: { disableSignIn: true } }), `${m.name} can no longer sign in.`); }}>
            Turn off sign-in
          </Button>
        )}
        <Button variant="danger" disabled={busy !== null}
          onClick={() => {
            const typed = prompt(`Remove ${m.name} from the household? This deletes their account and everything in their own brain — notes, files and facts they added. It can't be undone.\n\nType their name to confirm:`);
            if (typed === null) return;
            if (typed.trim() !== m.name) { setError("The name didn't match, so nothing was removed."); return; }
            run("remove", () => api(`/api/auth/members/${m.id}`, { method: "DELETE" }), `${m.name} was removed.`, onClose);
          }}>
          Remove from household
        </Button>
      </div>
    </div>
  );
}
