"use client";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { clsx } from "clsx";
import { Copy, Check } from "lucide-react";
import { Button, Field, Input, Select } from "@/components/ui";

/** Strings translated on the server (admin copy never goes into the client dictionary). */
export type ControlsCopy = Record<
  | "planTitle" | "planLead" | "planLabel" | "planSave" | "planSaved" | "planAdminFixed" | "planInherited" | "planPayments"
  | "addonsTitle" | "addonsLead" | "addonsNeedsUltimate" | "on" | "off" | "saved"
  | "accessTitle" | "accessLead" | "accessState" | "reason" | "reasonPlaceholder" | "lock" | "lockConfirm" | "unlock"
  | "lockedDone" | "unlockedDone" | "signOut" | "signOutConfirm" | "signedOutOne" | "signedOutOther" | "selfNote"
  | "pwTitle" | "pwLead" | "resetLink" | "resetLinkHint" | "resetReady" | "temp" | "tempHint" | "tempConfirm" | "tempReady"
  | "copy" | "copied" | "failed",
  string
>;

type Addon = { key: string; label: string; hint: string; group: string; on: boolean };

export function AccountControls({ id, plans, planKey, ownPlan, addons, groups, locked, isAdmin, isSelf, copy: c }: {
  id: string;
  plans: { key: string; name: string }[];
  planKey: string;
  ownPlan: string | null;
  addons: Addon[];
  groups: Record<string, string>;
  locked: boolean;
  isAdmin: boolean;
  isSelf: boolean;
  copy: ControlsCopy;
}) {
  const router = useRouter();
  const [plan, setPlan] = useState(ownPlan ?? planKey);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ where: string; text: string; tone: "ok" | "error" } | null>(null);
  const [reason, setReason] = useState("");
  const [secret, setSecret] = useState<{ kind: "link" | "password"; value: string; text: string } | null>(null);
  const onUltimate = (ownPlan ?? "") === "ultimate";

  async function act(where: string, payload: Record<string, unknown>, ok?: (r: Record<string, unknown>) => string | null) {
    setBusy(where);
    setNote(null);
    try {
      const res = await fetch(`/api/admin/accounts/${id}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
      });
      const r = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) throw new Error(typeof r.error === "string" ? r.error : c.failed);
      const msg = ok?.(r) ?? null;
      if (msg) setNote({ where, text: msg, tone: "ok" });
      router.refresh();
      return r;
    } catch (e) {
      setNote({ where, text: e instanceof Error ? e.message : c.failed, tone: "error" });
      return null;
    } finally {
      setBusy(null);
    }
  }

  const signedOut = (n: unknown) => (Number(n) === 1 ? c.signedOutOne : c.signedOutOther).replace("{count}", String(Number(n) || 0));
  const status = (where: string) => note?.where === where
    ? <p role="status" className={clsx("text-sm", note.tone === "error" ? "text-danger" : "text-muted")}>{note.text}</p>
    : null;
  const byGroup = Object.entries(groups).map(([g, label]) => ({ g, label, items: addons.filter((a) => a.group === g) }));

  return (
    <div className="space-y-10">
      <Block title={c.planTitle} lead={c.planLead}>
        {isAdmin ? <p className="text-sm text-muted">{c.planAdminFixed}</p> : (
          <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); void act("plan", { action: "set_plan", plan }, () => c.planSaved); }}>
            <Field label={c.planLabel} className="w-48">
              <Select value={plan} onChange={(e) => setPlan(e.target.value)}>
                {plans.map((p) => <option key={p.key} value={p.key}>{p.name}</option>)}
              </Select>
            </Field>
            <Button type="submit" disabled={busy === "plan" || plan === ownPlan}>{c.planSave}</Button>
          </form>
        )}
        {!ownPlan && c.planInherited && <p className="mt-3 text-sm text-muted">{c.planInherited}</p>}
        <div className="mt-3 space-y-1">
          {status("plan")}
          <p className="text-sm text-muted">{c.planPayments}</p>
        </div>
      </Block>

      <Block title={c.addonsTitle} lead={c.addonsLead}>
        {!onUltimate && !isAdmin && <p className="mb-3 rounded-md bg-surface-2 px-3 py-2 text-sm text-muted">{c.addonsNeedsUltimate}</p>}
        <div className="space-y-5">
          {byGroup.map(({ g, label, items }) => (
            <fieldset key={g} disabled={!onUltimate && !isAdmin}>
              {!(items.length === 1 && items[0].label === label) && <legend className="mb-2 text-sm font-medium">{label}</legend>}
              <ul className="divide-y divide-line">
                {items.map((a) => (
                  <li key={a.key} className="flex items-center gap-4 py-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">{a.label}</p>
                      <p className="text-sm text-muted">{a.hint}</p>
                    </div>
                    <Toggle on={a.on} label={a.label} disabled={busy === `addon:${a.key}` || isAdmin || (!onUltimate && !a.on)}
                      onLabel={c.on} offLabel={c.off}
                      onChange={(next) => void act(`addon:${a.key}`, { action: "set_addon", addon: a.key, enabled: next }, () => c.saved)} />
                  </li>
                ))}
              </ul>
              {items.map((a) => <div key={a.key}>{status(`addon:${a.key}`)}</div>)}
            </fieldset>
          ))}
        </div>
      </Block>

      <Block title={c.accessTitle} lead={c.accessLead}>
        <p className={clsx("text-sm", locked ? "font-medium text-danger" : "text-muted")}>{c.accessState}</p>
        {isSelf ? <p className="mt-3 text-sm text-muted">{c.selfNote}</p> : (
          <div className="mt-4 space-y-4">
            {locked ? (
              <Button variant="secondary" disabled={busy === "lock"} onClick={() => void act("lock", { action: "unlock" }, () => c.unlockedDone)}>{c.unlock}</Button>
            ) : !isAdmin && (
              <div className="flex flex-wrap items-end gap-3">
                <Field label={c.reason} className="min-w-0 flex-1 sm:max-w-sm">
                  <Input value={reason} maxLength={300} placeholder={c.reasonPlaceholder} onChange={(e) => setReason(e.target.value)} />
                </Field>
                <Button variant="danger" disabled={busy === "lock"}
                  onClick={() => { if (window.confirm(c.lockConfirm)) void act("lock", { action: "lock", reason }, () => c.lockedDone); }}>{c.lock}</Button>
              </div>
            )}
            <div>
              <Button variant="secondary" disabled={busy === "signout"}
                onClick={() => { if (window.confirm(c.signOutConfirm)) void act("signout", { action: "sign_out" }, (r) => signedOut(r.signedOut)); }}>{c.signOut}</Button>
            </div>
            {status("lock")}
            {status("signout")}
          </div>
        )}
      </Block>

      <Block title={c.pwTitle} lead={c.pwLead}>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Button variant="secondary" disabled={busy === "pw"}
              onClick={async () => {
                setSecret(null);
                const r = await act("pw", { action: "reset_link" });
                if (r && typeof r.url === "string") setSecret({ kind: "link", value: r.url, text: c.resetReady.replace("{date}", new Date(String(r.expiresAt)).toLocaleString()) });
              }}>{c.resetLink}</Button>
            <p className="mt-1.5 text-sm text-muted">{c.resetLinkHint}</p>
          </div>
          {!isSelf && (
            <div>
              <Button variant="secondary" disabled={busy === "pw"}
                onClick={async () => {
                  if (!window.confirm(c.tempConfirm)) return;
                  setSecret(null);
                  const r = await act("pw", { action: "temp_password" });
                  if (r && typeof r.password === "string") setSecret({ kind: "password", value: r.password, text: c.tempReady });
                }}>{c.temp}</Button>
              <p className="mt-1.5 text-sm text-muted">{c.tempHint}</p>
            </div>
          )}
        </div>
        {status("pw")}
        {secret && <Secret value={secret.value} text={secret.text} copy={c.copy} copied={c.copied} mono={secret.kind === "password"} />}
      </Block>
    </div>
  );
}

function Block({ title, lead, children }: { title: string; lead: string; children: ReactNode }) {
  return (
    <section className="grid gap-4 xl:grid-cols-[minmax(0,15rem)_minmax(0,1fr)] xl:gap-x-10">
      <div className="xl:pt-4">
        <h2 className="text-base font-semibold">{title}</h2>
        <p className="mt-1 max-w-[52ch] text-sm text-muted">{lead}</p>
      </div>
      <div className="min-w-0 rounded-lg bg-surface p-5">{children}</div>
    </section>
  );
}

function Toggle({ on, onChange, label, disabled, onLabel, offLabel }: {
  on: boolean; onChange: (next: boolean) => void; label: string; disabled?: boolean; onLabel: string; offLabel: string;
}) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={() => onChange(!on)}
      className="group inline-flex shrink-0 items-center gap-2 text-sm text-muted disabled:opacity-45">
      <span className="tabular-nums">{on ? onLabel : offLabel}</span>
      <span className={clsx("relative h-5 w-9 rounded-full transition-colors duration-150", on ? "bg-accent" : "bg-surface-2 ring-1 ring-inset ring-line")}>
        <span className={clsx("absolute top-0.5 size-4 rounded-full bg-white shadow-sm transition-transform duration-150 ease-out", on ? "translate-x-[18px]" : "translate-x-0.5")} />
      </span>
    </button>
  );
}

function Secret({ value, text, copy, copied, mono }: { value: string; text: string; copy: string; copied: string; mono: boolean }) {
  const [done, setDone] = useState(false);
  return (
    <div className="mt-4 rounded-md bg-accent-tint p-3">
      <p className="text-sm">{text}</p>
      <div className="mt-2 flex items-center gap-2">
        <code className={clsx("min-w-0 flex-1 select-all break-all rounded bg-surface px-2 py-1.5 text-sm", mono ? "font-mono tracking-wide" : "font-sans")}>{value}</code>
        <Button size="sm" variant="secondary" onClick={async () => {
          try { await navigator.clipboard.writeText(value); setDone(true); setTimeout(() => setDone(false), 2000); } catch { /* select-all lets them copy by hand */ }
        }}>{done ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}{done ? copied : copy}</Button>
      </div>
    </div>
  );
}
