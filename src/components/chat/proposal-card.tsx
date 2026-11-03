"use client";
import { useState } from "react";
import { Bell, BookOpen, Check, GitBranch, X } from "lucide-react";
import { Button } from "@/components/ui";
import type { ProposalView } from "@/lib/assistant/proposals";

const KIND = {
  propose_reminder: { icon: Bell, label: "Suggested reminder" },
  propose_fact: { icon: GitBranch, label: "Suggested fact" },
  propose_wiki_note: { icon: BookOpen, label: "Suggested wiki page" },
} as const;

function dueLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }).format(d);
}

/** A suggestion from the assistant. Nothing is written until the user approves it. */
export function ProposalCard({ conversationId, messageId, proposal, onDecided }: {
  conversationId: string; messageId: string; proposal: ProposalView; onDecided: (p: ProposalView) => void;
}) {
  const [busy, setBusy] = useState<null | "approve" | "dismiss">(null);
  const [error, setError] = useState<string | null>(null);
  const { icon: Icon, label } = KIND[proposal.type];

  async function decide(action: "approve" | "dismiss") {
    setBusy(action);
    setError(null);
    try {
      const res = await fetch(`/api/chat/${conversationId}/proposals/${proposal.n}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messageId, action }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof body.error === "string" ? body.error : "That didn't work. Please try again.");
      onDecided({ ...proposal, status: body.status, result: body.result ?? null });
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't work. Please try again.");
    } finally {
      setBusy(null);
    }
  }

  const decided = proposal.status !== "pending";
  return (
    <div className={`rounded-lg border p-3 text-sm ${decided ? "border-line bg-surface-2/50" : "border-line bg-surface"}`} role="group" aria-label={label}>
      <div className="flex items-start gap-3">
        <Icon aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium uppercase tracking-wide text-muted">{label}</p>
          {proposal.type === "propose_reminder" && (
            <>
              <p className="mt-1 font-medium">{proposal.title}</p>
              <p className="text-muted">{dueLabel(proposal.dueAt)}{proposal.aboutPerson ? ` · about ${proposal.aboutPerson}` : ""}</p>
              {proposal.detail && <p className="mt-1 text-muted">{proposal.detail}</p>}
            </>
          )}
          {proposal.type === "propose_fact" && (
            <>
              <p className="mt-1 font-medium">{proposal.from} <span className="font-normal text-muted">{proposal.relation.replace(/_/g, " ")}</span> {proposal.to}</p>
              <p className="text-xs text-inferred">Saved as a guess (inferred) until someone confirms it.</p>
            </>
          )}
          {proposal.type === "propose_wiki_note" && (
            <>
              <p className="mt-1 font-medium">{proposal.title}</p>
              <p className="mt-1 line-clamp-3 whitespace-pre-line text-muted">{proposal.text}</p>
            </>
          )}

          {decided ? (
            <p className="mt-2 flex items-center gap-1 text-xs text-muted" role="status">
              {proposal.status === "approved" ? <Check aria-hidden className="h-3.5 w-3.5 text-accent" /> : <X aria-hidden className="h-3.5 w-3.5" />}
              {proposal.status === "approved"
                ? (proposal.result?.href
                  ? <a className="text-accent underline-offset-2 hover:underline" href={proposal.result.href}>{proposal.result.label}</a>
                  : proposal.result?.label ?? "Approved")
                : "Dismissed"}
            </p>
          ) : (
            <div className="mt-3 flex flex-wrap gap-2">
              <Button type="button" onClick={() => decide("approve")} disabled={!!busy} aria-busy={busy === "approve"}>
                <Check aria-hidden className="h-4 w-4" /> {busy === "approve" ? "Saving…" : "Approve"}
              </Button>
              <Button type="button" variant="secondary" onClick={() => decide("dismiss")} disabled={!!busy}>
                Dismiss
              </Button>
            </div>
          )}
          {error && <p className="mt-2 text-xs text-danger" role="alert">{error}</p>}
        </div>
      </div>
    </div>
  );
}
