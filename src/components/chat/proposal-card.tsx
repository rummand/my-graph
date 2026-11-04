"use client";
import { useState } from "react";
import { motion } from "motion/react";
import { ArrowRight, Bookmark, Check, Undo2 } from "lucide-react";
import { format } from "date-fns";
import { ApprovalCard, type Decision } from "@/components/assistant/approval-card";
import type { Citation } from "@/db/schema";
import type { ProposalView } from "@/lib/assistant/proposals";
import { alwaysLabelOf } from "@/lib/assistant/policy";

const EASE = [0.22, 1, 0.36, 1] as const;

const KIND: Record<ProposalView["type"], { label: string; title: (p: ProposalView) => string }> = {
  propose_reminder: { label: "Reminder", title: () => "Add this reminder?" },
  propose_fact: { label: "Fact", title: () => "Save this to your graph?" },
  propose_wiki_note: { label: "Wiki page", title: () => "Start this wiki page?" },
  propose_memory: {
    label: "Memory",
    title: (p) => (p.type === "propose_memory" && p.kind === "rule" ? "Remember this family rule?" : p.type === "propose_memory" && p.kind === "preference" ? "Remember this preference?" : "Remember this?"),
  },
};

function dueLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const end = d.getHours() === 23 && d.getMinutes() === 59;
  return end ? `${format(d, "EEE d MMM")}, by the end of the day` : format(d, "EEE d MMM, HH:mm");
}

/** Exactly what would be saved, and what it changes. */
function Preview({ p }: { p: ProposalView }) {
  return (
    <div className="space-y-2">
      {p.type === "propose_reminder" && (
        <div>
          <p className="font-medium">{p.title}</p>
          <p className="mt-0.5 text-muted">Due {dueLabel(p.dueAt)}{p.aboutPerson && <>, for {p.aboutPerson}</>}</p>
          {p.detail && <p className="mt-1 text-muted">{p.detail}</p>}
          <p className="mt-1 text-xs text-muted">Only you will see this reminder.</p>
        </div>
      )}
      {p.type === "propose_fact" && (
        <div>
          {p.current?.length ? (
            <div className="mb-2 space-y-0.5">
              <p className="text-xs text-muted">Already in your graph</p>
              {p.current.map((c) => <p key={c} className="text-muted line-through decoration-muted/50">{c}</p>)}
              <p className="pt-1 text-xs text-muted">Will add</p>
            </div>
          ) : null}
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-medium">
            <span>{p.from}</span>
            <span className="inline-flex items-center gap-1 font-normal text-muted">{p.relation.replace(/_/g, " ")}<ArrowRight aria-hidden className="size-3.5" /></span>
            <span>{p.to}</span>
          </p>
          {p.quote && <p className="mt-1 font-read text-muted">&ldquo;{p.quote}&rdquo;</p>}
          <p className="mt-1 text-inferred">Saved as a guess until someone in the family confirms it.</p>
        </div>
      )}
      {p.type === "propose_wiki_note" && (
        <div>
          <p className="font-medium">{p.title}</p>
          <p className="mt-1 max-h-40 overflow-y-auto whitespace-pre-line font-read leading-relaxed text-muted">{p.text}</p>
          <p className="mt-1 text-xs text-muted">A new private page. Nothing existing is changed.</p>
        </div>
      )}
      {p.type === "propose_memory" && (
        <div>
          <p className="font-medium">{p.text}</p>
          {p.about.length > 0 && <p className="mt-0.5 text-muted">About {p.about.join(", ")}</p>}
          {p.quote && <p className="mt-1 font-read text-muted">You said: &ldquo;{p.quote}&rdquo;</p>}
        </div>
      )}
      {p.widens && <p className="rounded-md bg-warn-tint px-2.5 py-1.5 text-warn">{p.widens}</p>}
    </div>
  );
}

function why(p: ProposalView): string | undefined {
  if (p.basis === "document") return "This comes only from a document, not from something you said. Check it before you approve.";
  if (p.type === "propose_memory") return "It will apply this from now on, in every conversation. You can change it in Memory.";
  return undefined;
}

function summary(p: ProposalView): string {
  if (p.type === "propose_fact") return `${p.from} ${p.relation.replace(/_/g, " ")} ${p.to}`;
  if (p.type === "propose_memory") return p.text;
  return p.title;
}

/** A suggestion from the assistant (Scout's approval card). Nothing is written until someone approves it. */
export function ProposalCard({ conversationId, messageId, proposal, citations, onDecided }: {
  conversationId: string; messageId: string; proposal: ProposalView; citations: Citation[]; onDecided: (p: ProposalView) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function post(action: "approve" | "always" | "deny" | "undo") {
    const res = await fetch(`/api/chat/${conversationId}/proposals/${proposal.n}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messageId, action }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(typeof body.error === "string" ? body.error : "That didn't go through. Try again in a moment.");
    return body as { status: ProposalView["status"]; result: ProposalView["result"]; label?: string; href?: string };
  }

  async function decide(d: Decision) {
    const body = await post(d);
    // Let the card show its confirmation, then settle into the quiet line with Undo.
    window.setTimeout(() => onDecided({ ...proposal, status: body.status, result: body.result ?? null, auto: null }), 900);
    return { ok: true, label: body.label ?? (d === "deny" ? undefined : "Saved."), href: body.href };
  }

  async function undo() {
    setBusy(true); setError(null);
    try {
      const body = await post("undo");
      onDecided({ ...proposal, status: body.status, result: body.result ?? proposal.result ?? null });
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't go through.");
    } finally {
      setBusy(false);
    }
  }

  if (proposal.status === "pending") {
    const kind = KIND[proposal.type];
    return (
      <ApprovalCard
        title={kind.title(proposal)} kindLabel={kind.label} why={why(proposal)} preview={<Preview p={proposal} />}
        citations={proposal.basis === "document" ? citations : []}
        alwaysLabel={proposal.basis === "document" || proposal.widens ? undefined : alwaysLabelOf(proposal)}
        onDecide={decide}
      />
    );
  }

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.18, ease: EASE }} role="status"
      className="flex flex-wrap items-center gap-x-2 gap-y-1 px-1 py-1 text-sm text-muted">
      {proposal.status === "approved" ? (
        <>
          {proposal.type === "propose_memory" ? <Bookmark aria-hidden className="size-4 text-accent" /> : <Check aria-hidden className="size-4 text-accent" />}
          <span className="min-w-0">
            {proposal.auto === "always" && <>Saved automatically (you chose always allow). </>}
            {proposal.result?.href
              ? <a className="text-fg underline decoration-line underline-offset-4 hover:decoration-accent" href={proposal.result.href}>{proposal.result.label}</a>
              : <span className={proposal.auto === "setting" ? "" : "text-fg"}>{proposal.result?.label ?? "Saved"}</span>}
          </span>
          {proposal.result?.undo && (
            <button type="button" onClick={undo} disabled={busy}
              className="inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-fg transition-colors hover:bg-surface-2 disabled:opacity-60">
              <Undo2 aria-hidden className="size-3.5" />{busy ? "Undoing…" : "Undo"}
            </button>
          )}
        </>
      ) : proposal.status === "undone" ? (
        <><Undo2 aria-hidden className="size-4" /><span className="min-w-0">Undone: {summary(proposal)}</span></>
      ) : (
        <><Undo2 aria-hidden className="size-4" /><span className="min-w-0">Not saved: {summary(proposal)}</span></>
      )}
      {error && <span role="alert" className="w-full text-danger">{error}</span>}
    </motion.div>
  );
}
