"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ChevronDown } from "lucide-react";
import { clsx } from "clsx";
import { Avatar, Badge, Button, Input, Select } from "@/components/ui";
import { api, errorFields, errorMessage, type FieldErrors } from "@/lib/auth/client/api";
import { describedBy, Field } from "@/lib/auth/client/field";
import { roleLabel } from "@/lib/auth/audit-labels";
import type { MemberView } from "@/lib/auth/settings-data";
import { ErrorNote, Notice } from "@/app/login/notes";
import { fmtDate, plural } from "./format";
import { SessionList } from "./session-list";

const ymd = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** One short sentence about a member's account, in the words a parent would use. */
function describe(m: MemberView): string {
  const bits: string[] = [roleLabel(m.role)];
  if (m.birthYear) bits.push(`${new Date().getFullYear() - m.birthYear} years old`);
  bits.push(m.sessions.length ? `on ${plural(m.sessions.length, "device")}` : "not signed in yet");
  return bits.join(", ");
}

export function MemberList({ members, viewerRole }: { members: MemberView[]; viewerRole: string }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <ul className="divide-y divide-line px-2">
      {members.map((m) => {
        const expired = m.role === "guest" && (!m.accessExpiresAt || new Date(m.accessExpiresAt) <= new Date());
        const isOpen = open === m.id && m.canManage;
        const pid = m.personNodeId ?? m.id;
        return (
          <li key={m.id} className="py-1">
            <div className="flex items-center gap-3 rounded-md px-3 py-2.5">
              <Avatar id={pid} name={m.name} size={36} />
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  {m.personNodeId
                    ? <Link href={`/people/${m.personNodeId}`} className="font-medium hover:underline underline-offset-2">{m.name}</Link>
                    : <span className="font-medium">{m.name}</span>}
                  {m.isYou && <Badge>You</Badge>}
                  {!m.canSignIn && <Badge tone="warn">Can&apos;t sign in</Badge>}
                  {m.role === "guest" && (expired ? <Badge tone="danger">Access ended</Badge> : m.accessExpiresAt && <Badge>Until {fmtDate(m.accessExpiresAt)}</Badge>)}
                </p>
                <p className="text-sm text-muted">{describe(m)}</p>
              </div>
              <p className="hidden w-44 shrink-0 truncate text-sm text-muted md:block" title={m.email}>{m.email}</p>
              {m.canManage ? (
                <Button variant="ghost" size="sm" onClick={() => setOpen(isOpen ? null : m.id)} aria-expanded={isOpen} aria-controls={`member-${m.id}`}>
                  {isOpen ? "Close" : "Manage"}
                  <ChevronDown size={14} aria-hidden className={clsx("transition-transform duration-200", isOpen && "rotate-180")} />
                </Button>
              ) : <span className="w-[94px] shrink-0" aria-hidden />}
            </div>
            <AnimatePresence initial={false}>
              {isOpen && (
                <motion.div id={`member-${m.id}`} key="editor" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }} className="overflow-hidden">
                  <div className="mx-1 mb-3 mt-1 rounded-md bg-bg p-4 sm:p-5">
                    <MemberEditor member={m} canChangeRole={viewerRole === "owner"} onClose={() => setOpen(null)} />
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
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
  const h3 = "mb-3 text-sm font-semibold";

  return (
    <div className="space-y-7">
      <form onSubmit={save} noValidate>
        <h3 className={h3}>Details</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id={`me-name-${m.id}`} label="Name" error={fields.name}>
            <Input id={`me-name-${m.id}`} value={name} onChange={(e) => setName(e.target.value)} maxLength={80}
              aria-invalid={!!fields.name || undefined} aria-describedby={describedBy(`me-name-${m.id}`, fields.name)} />
          </Field>
          <Field id={`me-email-${m.id}`} label="Email or username" error={fields.email}>
            <Input id={`me-email-${m.id}`} value={email} onChange={(e) => setEmail(e.target.value)} autoCapitalize="none" spellCheck={false}
              aria-invalid={!!fields.email || undefined} aria-describedby={describedBy(`me-email-${m.id}`, fields.email)} />
          </Field>
          <Field id={`me-role-${m.id}`} label="Role">
            <Select id={`me-role-${m.id}`} value={role} onChange={(e) => setRole(e.target.value as MemberView["role"])}>
              {roleOptions.map((r) => <option key={r} value={r}>{roleLabel(r)}</option>)}
            </Select>
          </Field>
          {role === "child" && (
            <Field id={`me-by-${m.id}`} label="Birth year" error={fields.birthYear}>
              <Input id={`me-by-${m.id}`} inputMode="numeric" maxLength={4} value={birthYear} onChange={(e) => setBirthYear(e.target.value.replace(/\D/g, ""))}
                className="tabular-nums" aria-invalid={!!fields.birthYear || undefined} aria-describedby={describedBy(`me-by-${m.id}`, fields.birthYear)} />
            </Field>
          )}
          {role === "guest" && (
            <Field id={`me-until-${m.id}`} label="Access until" error={fields.accessExpiresAt}>
              <Input id={`me-until-${m.id}`} type="date" value={until} onChange={(e) => setUntil(e.target.value)}
                aria-invalid={!!fields.accessExpiresAt || undefined} aria-describedby={describedBy(`me-until-${m.id}`, fields.accessExpiresAt)} />
            </Field>
          )}
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-end gap-3">
          <Button type="submit" size="sm" disabled={busy !== null}>{busy === "save" ? "Saving…" : "Save changes"}</Button>
        </div>
      </form>

      <form noValidate
        onSubmit={(e) => { e.preventDefault(); run("pw", () => api(`/api/auth/members/${m.id}`, { method: "PATCH", json: { password } }), `New password set. ${m.name} is signed out everywhere.`, () => setPassword("")); }}>
        <h3 className={h3}>Password</h3>
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-0 flex-1 basis-56">
            <Field id={`me-pw-${m.id}`} label={`New password for ${m.name}`} error={fields.password}>
              <Input id={`me-pw-${m.id}`} type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)}
                aria-invalid={!!fields.password || undefined} aria-describedby={describedBy(`me-pw-${m.id}`, fields.password, true)} />
            </Field>
          </div>
          <Button type="submit" variant="secondary" disabled={busy !== null || password.length === 0}>{busy === "pw" ? "Setting…" : "Set password"}</Button>
        </div>
        {!fields.password && <p id={`me-pw-${m.id}-hint`} className="mt-1 text-xs text-muted">At least 10 characters. They&apos;ll be signed out everywhere.</p>}
      </form>

      <div>
        <h3 className={h3}>{m.name}&apos;s devices</h3>
        <SessionList sessions={m.sessions} allowSignOutOthers={false} inset />
      </div>

      {(error || notice) && (
        <div className="space-y-2">
          <ErrorNote message={error} />
          <Notice message={notice} />
        </div>
      )}

      <div>
        <h3 className={h3}>Access</h3>
        <div className="space-y-3">
          {m.canSignIn && (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="min-w-0 flex-1 basis-64 text-sm text-muted">Turning off sign-in stops their password and passkeys and signs them out. Their brain stays.</p>
              <Button variant="secondary" size="sm" disabled={busy !== null}
                onClick={() => { if (confirm(`Turn off sign-in for ${m.name}? Their password and passkeys stop working and they're signed out everywhere. Their brain stays, and you can set a new password later.`)) run("disable", () => api(`/api/auth/members/${m.id}`, { method: "PATCH", json: { disableSignIn: true } }), `${m.name} can no longer sign in.`); }}>
                Turn off sign-in
              </Button>
            </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="min-w-0 flex-1 basis-64 text-sm text-muted">Removing {m.name} deletes their account and everything in their own brain. This can&apos;t be undone.</p>
            <button type="button" className="inline-flex h-8 shrink-0 items-center rounded-md px-2.5 text-sm font-medium text-danger transition-colors hover:bg-danger-tint disabled:opacity-45" disabled={busy !== null}
              onClick={() => {
                const typed = prompt(`Remove ${m.name} from the household? This deletes their account and everything in their own brain: notes, files and facts they added. It can't be undone.\n\nType their name to confirm:`);
                if (typed === null) return;
                if (typed.trim() !== m.name) { setError("The name didn't match, so nothing was removed."); return; }
                run("remove", () => api(`/api/auth/members/${m.id}`, { method: "DELETE" }), `${m.name} was removed.`, onClose);
              }}>
              Remove {m.name}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
