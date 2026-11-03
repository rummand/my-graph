"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui";
import { api, errorMessage } from "@/lib/auth/client/api";
import { FormError } from "@/lib/auth/client/field";
import { roleLabel } from "@/lib/auth/audit-labels";
import { fmtAgo } from "./format";

type Pending = { id: string; device: string; createdAt: string; memberName: string; memberRole: string; canManage: boolean };

export function PendingApprovals({ pending }: { pending: Pending[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function decide(id: string, approve: boolean) {
    setBusy(id); setError(null);
    try {
      await api(`/api/auth/sessions/${id}`, { json: { approve } });
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-3">
      <ul className="divide-y divide-line rounded-md border border-line">
        {pending.map((p) => (
          <li key={p.id} className="flex flex-wrap items-center gap-3 px-3 py-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{p.memberName} <span className="font-normal text-muted">({roleLabel(p.memberRole).toLowerCase()})</span></p>
              <p className="text-xs text-muted">{p.device} · asked {fmtAgo(p.createdAt)}</p>
            </div>
            {p.canManage ? (
              <div className="flex gap-2">
                <Button onClick={() => decide(p.id, true)} disabled={busy !== null} aria-label={`Approve ${p.device} for ${p.memberName}`}>Approve</Button>
                <Button variant="secondary" onClick={() => decide(p.id, false)} disabled={busy !== null} aria-label={`Turn away ${p.device} for ${p.memberName}`}>Turn away</Button>
              </div>
            ) : <p className="text-xs text-muted">The owner can approve this.</p>}
          </li>
        ))}
      </ul>
      <FormError message={error} />
    </div>
  );
}
