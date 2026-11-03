"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Avatar, Button } from "@/components/ui";
import { api, errorMessage } from "@/lib/auth/client/api";
import { roleLabel } from "@/lib/auth/audit-labels";
import { ErrorNote } from "@/app/login/notes";
import { fmtAgo } from "./format";

type Pending = { id: string; device: string; createdAt: string; memberName: string; memberRole: string; memberId: string; canManage: boolean };

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
    <div className="px-5 py-2">
      <ul className="divide-y divide-warn/20">
        <AnimatePresence initial={false}>
          {pending.map((p) => (
            <motion.li key={p.id} layout exit={{ opacity: 0, height: 0 }} className="flex flex-wrap items-center gap-3 py-3">
              <Avatar id={p.memberId} name={p.memberName} size={32} />
              <div className="min-w-0 flex-1">
                <p className="text-fg"><span className="font-medium">{p.memberName}</span> wants to use {p.device}</p>
                <p className="text-sm text-muted">{roleLabel(p.memberRole)}, asked {fmtAgo(p.createdAt)}</p>
              </div>
              {p.canManage ? (
                <div className="flex gap-2">
                  <Button variant="secondary" size="sm" onClick={() => decide(p.id, false)} disabled={busy !== null} aria-label={`Turn away ${p.device} for ${p.memberName}`}>Turn away</Button>
                  <Button size="sm" onClick={() => decide(p.id, true)} disabled={busy !== null} aria-label={`Approve ${p.device} for ${p.memberName}`}>{busy === p.id ? "Approving…" : "Approve"}</Button>
                </div>
              ) : <p className="text-sm text-muted">The owner can approve this.</p>}
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
      <ErrorNote message={error} className="mb-3" />
    </div>
  );
}
