"use client";
import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowRight, Bell, BookOpen, Check, GitBranch, Undo2 } from "lucide-react";
import { format } from "date-fns";
import { Button } from "@/components/ui";
import type { ProposalView } from "@/lib/assistant/proposals";

const KIND = {
  propose_reminder: { icon: Bell, ask: "Add this reminder?", approve: "Add reminder" },
  propose_fact: { icon: GitBranch, ask: "Save this to your graph?", approve: "Save as a guess" },
  propose_wiki_note: { icon: BookOpen, ask: "Start this wiki page?", approve: "Create page" },
} as const;

const EASE = [0.22, 1, 0.36, 1] as const;

function dueLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const end = d.getHours() === 23 && d.getMinutes() === 59;
  return end ? `${format(d, "EEE d MMM")}, by the end of the day` : format(d, "EEE d MMM, HH:mm");
}

/** A suggestion from the assistant. Nothing is written until someone approves it. */
export function ProposalCard({ conversationId, messageId, proposal, onDecided }: {
  conversationId: string; messageId: string; proposal: ProposalView; onDecided: (p: ProposalView) => void;
}) {
  const [busy, setBusy] = useState<null | "approve" | "dismiss">(null);
  const [error, setError] = useState<string | null>(null);
  const { icon: Icon, ask, approve } = KIND[proposal.type];

  async function decide(action: "approve" | "dismiss") {
    setBusy(action);
    setError(null);
    try {
      const res = await fetch(`/api/chat/${conversationId}/proposals/${proposal.n}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messageId, action }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof body.error === "string" ? body.error : "That didn't save. Try again in a moment.");
      onDecided({ ...proposal, status: body.status, result: body.result ?? null });
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't save. Try again in a moment.");
    } finally {
      setBusy(null);
    }
  }

  const decided = proposal.status !== "pending";
  return (
    <motion.div layout transition={{ duration: 0.22, ease: EASE }} role="group" aria-label={ask}
      className={decided ? "rounded-lg px-4 py-2.5" : "rounded-lg bg-surface p-4"}>
      <AnimatePresence mode="popLayout" initial={false}>
        {decided ? (
          <motion.p key="done" role="status" className="flex items-center gap-2 text-sm text-muted"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.18, delay: 0.05 }}>
            {proposal.status === "approved" ? (
              <>
                <Check aria-hidden className="size-4 text-accent" />
                <span className="min-w-0 truncate">
                  {proposal.result?.href
                    ? <a className="text-fg underline decoration-line underline-offset-4 hover:decoration-accent" href={proposal.result.href}>{proposal.result.label}</a>
                    : <span className="text-fg">{proposal.result?.label ?? "Saved"}</span>}
                </span>
              </>
            ) : (
              <><Undo2 aria-hidden className="size-4" /><span className="min-w-0 truncate">Not saved: {summary(proposal)}</span></>
            )}
          </motion.p>
        ) : (
          <motion.div key="ask" initial={false} exit={{ opacity: 0 }} transition={{ duration: 0.12 }}>
            <p className="flex items-center gap-2 text-sm text-muted">
              <span aria-hidden className="size-1.5 rounded-full bg-warn" />
              <Icon aria-hidden className="size-4" />{ask}
            </p>
            <div className="mt-2.5">
              {proposal.type === "propose_reminder" && (
                <>
                  <p className="font-medium">{proposal.title}</p>
                  <p className="mt-0.5 text-sm text-muted">
                    {dueLabel(proposal.dueAt)}
                    {proposal.aboutPerson && <>, for {proposal.aboutPerson}</>}
                  </p>
                  {proposal.detail && <p className="mt-1.5 text-sm text-muted">{proposal.detail}</p>}
                </>
              )}
              {proposal.type === "propose_fact" && (
                <>
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-medium">
                    <span>{proposal.from}</span>
                    <span className="inline-flex items-center gap-1 text-sm font-normal text-muted">
                      {proposal.relation.replace(/_/g, " ")}<ArrowRight aria-hidden className="size-3.5" />
                    </span>
                    <span>{proposal.to}</span>
                  </p>
                  <p className="mt-1 text-sm text-inferred">Saved as a guess until someone in the family confirms it.</p>
                </>
              )}
              {proposal.type === "propose_wiki_note" && (
                <>
                  <p className="font-medium">{proposal.title}</p>
                  <p className="mt-1 line-clamp-3 whitespace-pre-line font-read text-sm leading-relaxed text-muted">{proposal.text}</p>
                </>
              )}
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <Button type="button" size="sm" onClick={() => decide("approve")} disabled={!!busy} aria-busy={busy === "approve"}>
                <Check aria-hidden className="size-4" /> {busy === "approve" ? "Saving…" : approve}
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => decide("dismiss")} disabled={!!busy}>
                {busy === "dismiss" ? "Dismissing…" : "Not now"}
              </Button>
            </div>
            {error && <p className="mt-2 text-sm text-danger" role="alert">{error}</p>}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function summary(p: ProposalView): string {
  if (p.type === "propose_fact") return `${p.from} ${p.relation.replace(/_/g, " ")} ${p.to}`;
  return p.title;
}
