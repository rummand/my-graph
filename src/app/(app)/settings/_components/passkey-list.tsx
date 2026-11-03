"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { KeyRound } from "lucide-react";
import { Button, EmptyState, Input } from "@/components/ui";
import { api, errorMessage } from "@/lib/auth/client/api";
import { FormError, FormNotice } from "@/lib/auth/client/field";
import { addPasskey, guessDeviceName, passkeysSupported } from "@/lib/auth/client/passkeys";
import { fmtDate } from "./format";

type Pk = { id: string; name: string; createdAt: string };

export function PasskeyList({ passkeys }: { passkeys: Pk[] }) {
  const router = useRouter();
  const [supported, setSupported] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  useEffect(() => setSupported(passkeysSupported()), []);

  async function run(key: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(key); setError(null); setNotice(null);
    try {
      await fn();
      setNotice(ok);
      setEditing(null);
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      {passkeys.length === 0 ? (
        <EmptyState title="No passkeys yet">Add one to sign in without a password on this device.</EmptyState>
      ) : (
        <ul className="divide-y divide-line rounded-md border border-line">
          {passkeys.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-3 px-3 py-3">
              <KeyRound size={16} className="shrink-0 text-muted" aria-hidden="true" />
              {editing === p.id ? (
                <form className="flex min-w-0 flex-1 flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); run(p.id, () => api(`/api/auth/passkeys/${p.id}`, { method: "PATCH", json: { name: draft } }), "Passkey renamed."); }}>
                  <label htmlFor={`pk-${p.id}`} className="sr-only">Passkey name</label>
                  <Input id={`pk-${p.id}`} value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={60} className="min-w-0 flex-1" autoFocus />
                  <Button type="submit" variant="secondary" disabled={busy !== null || !draft.trim()}>Save</Button>
                  <Button type="button" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
                </form>
              ) : (
                <>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{p.name}</p>
                    <p className="text-xs text-muted">Added {fmtDate(p.createdAt)}</p>
                  </div>
                  <div className="flex gap-1">
                    <Button variant="ghost" onClick={() => { setEditing(p.id); setDraft(p.name); }} aria-label={`Rename ${p.name}`}>Rename</Button>
                    <Button variant="ghost" disabled={busy !== null} aria-label={`Remove ${p.name}`}
                      onClick={() => { if (confirm(`Remove the passkey “${p.name}”? You won't be able to sign in with it any more.`)) run(p.id, () => api(`/api/auth/passkeys/${p.id}`, { method: "DELETE" }), "Passkey removed."); }}>
                      Remove
                    </Button>
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      <FormError message={error} />
      <FormNotice message={notice} />
      {supported ? (
        <Button onClick={() => run("add", () => addPasskey(guessDeviceName()), "Passkey added. You can use it next time you sign in.")} disabled={busy !== null}>
          <KeyRound size={16} aria-hidden="true" />{busy === "add" ? "Follow your device's prompt…" : "Add a passkey on this device"}
        </Button>
      ) : (
        <p className="text-sm text-muted">This browser doesn&apos;t support passkeys. Try a recent version of Safari, Chrome, Edge or Firefox.</p>
      )}
    </div>
  );
}
