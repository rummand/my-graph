"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Monitor } from "lucide-react";
import { Button, EmptyState } from "@/components/ui";
import { api, errorMessage } from "@/lib/auth/client/api";
import { FormError, FormNotice } from "@/lib/auth/client/field";
import type { SessionView } from "@/lib/auth/settings-data";
import { fmtAgo, fmtDate } from "./format";
import { Badge } from "./section";

export function SessionList({ sessions, allowSignOutOthers = true }: { sessions: SessionView[]; allowSignOutOthers?: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const others = sessions.filter((s) => !s.current).length;

  async function run(key: string, fn: () => Promise<{ signedOutHere?: boolean; signedOut?: number }>) {
    setBusy(key); setError(null); setNotice(null);
    try {
      const r = await fn();
      if (r.signedOutHere) { router.replace("/login?reason=signed_out"); return; }
      setNotice(typeof r.signedOut === "number" ? `Signed out ${r.signedOut} device${r.signedOut === 1 ? "" : "s"}.` : "Signed out.");
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  if (!sessions.length) return <EmptyState title="Not signed in anywhere">Sessions show up here after signing in.</EmptyState>;

  return (
    <div className="space-y-4">
      <ul className="divide-y divide-line rounded-md border border-line">
        {sessions.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center gap-3 px-3 py-3">
            <Monitor size={16} className="shrink-0 text-muted" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                {s.device}
                {s.current && <Badge tone="accent">This device</Badge>}
                {!s.approved && <Badge tone="warn">Waiting for approval</Badge>}
              </p>
              <p className="text-xs text-muted">Signed in {fmtDate(s.createdAt)} · last active {fmtAgo(s.lastSeenAt)}</p>
            </div>
            {!s.current && (
              <Button variant="ghost" disabled={busy !== null} onClick={() => run(s.id, () => api(`/api/auth/sessions/${s.id}`, { method: "DELETE" }))}
                aria-label={`Sign out ${s.device}`}>
                Sign out
              </Button>
            )}
          </li>
        ))}
      </ul>
      <FormError message={error} />
      <FormNotice message={notice} />
      {allowSignOutOthers && others > 0 && (
        <Button variant="secondary" disabled={busy !== null} onClick={() => run("others", () => api("/api/auth/sessions", { method: "DELETE" }))}>
          {busy === "others" ? "Signing out…" : "Sign out all other devices"}
        </Button>
      )}
    </div>
  );
}
