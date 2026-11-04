"use client";
import { useState } from "react";
import { motion } from "motion/react";
import { ArrowRight, Bookmark, Check, Undo2 } from "lucide-react";
import { useFormatDate, useT } from "@/lib/i18n/client";
import { useIsFamily } from "./graph-kind";
import { resultWords } from "./words";
import { ApprovalCard, type Decision } from "@/components/assistant/approval-card";
import type { Citation } from "@/db/schema";
import type { ProposalView } from "@/lib/assistant/proposals";

const EASE = [0.22, 1, 0.36, 1] as const;

type T = ReturnType<typeof useT>;

function titleOf(p: ProposalView, t: T, family: boolean): string {
  if (p.type !== "propose_memory") return t(`chat.proposal.title.${p.type}`);
  if (p.kind === "rule") return t(family ? "chat.proposal.title.familyRule" : "chat.proposal.title.rule");
  if (p.kind === "preference") return t("chat.proposal.title.preference");
  return t("chat.proposal.title.memory");
}

function useDue() {
  const t = useT();
  const fmt = useFormatDate();
  return (iso: string): string => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    // "End of day" is 23:59 in the reader's own zone.
    const end = fmt(d, "time") === "23:59";
    return end ? t("chat.proposal.endOfDay", { day: fmt(d, "weekday") }) : `${fmt(d, "weekday")}, ${fmt(d, "time")}`;
  };
}

/** Exactly what would be saved, and what it changes. */
function Preview({ p }: { p: ProposalView }) {
  const t = useT();
  const family = useIsFamily();
  const due = useDue();
  return (
    <div className="space-y-2">
      {p.type === "propose_reminder" && (
        <div>
          <p className="font-medium">{p.title}</p>
          <p className="mt-0.5 text-muted" suppressHydrationWarning>{p.aboutPerson ? t("chat.proposal.dueFor", { when: due(p.dueAt), who: p.aboutPerson }) : t("chat.proposal.due", { when: due(p.dueAt) })}</p>
          {p.detail && <p className="mt-1 text-muted">{p.detail}</p>}
          <p className="mt-1 text-xs text-muted">{t("chat.proposal.onlyYou")}</p>
        </div>
      )}
      {p.type === "propose_fact" && (
        <div>
          {p.current?.length ? (
            <div className="mb-2 space-y-0.5">
              <p className="text-xs text-muted">{t("chat.proposal.already")}</p>
              {p.current.map((c) => <p key={c} className="text-muted line-through decoration-muted/50">{c}</p>)}
              <p className="pt-1 text-xs text-muted">{t("chat.proposal.willAdd")}</p>
            </div>
          ) : null}
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-medium">
            <span>{p.from}</span>
            <span className="inline-flex items-center gap-1 font-normal text-muted">{p.relation.replace(/_/g, " ")}<ArrowRight aria-hidden className="size-3.5" /></span>
            <span>{p.to}</span>
          </p>
          {p.quote && <p className="mt-1 font-read text-muted">&ldquo;{p.quote}&rdquo;</p>}
          <p className="mt-1 text-inferred">{t(family ? "chat.proposal.guessFamily" : "chat.proposal.guess")}</p>
        </div>
      )}
      {p.type === "propose_wiki_note" && (
        <div>
          <p className="font-medium">{p.title}</p>
          <p className="mt-1 max-h-40 overflow-y-auto whitespace-pre-line font-read leading-relaxed text-muted">{p.text}</p>
          <p className="mt-1 text-xs text-muted">{t("chat.proposal.newPage")}</p>
        </div>
      )}
      {p.type === "propose_memory" && (
        <div>
          <p className="font-medium">{p.text}</p>
          {p.about.length > 0 && <p className="mt-0.5 text-muted">{t("chat.proposal.about", { who: p.about.join(", ") })}</p>}
          {p.quote && <p className="mt-1 font-read text-muted">{t("chat.proposal.youSaid", { quote: p.quote })}</p>}
        </div>
      )}
      {p.widens && <p className="rounded-md bg-warn-tint px-2.5 py-1.5 text-warn">{p.widens}</p>}
    </div>
  );
}

function why(p: ProposalView, t: T): string | undefined {
  if (p.basis === "document") return t("chat.proposal.whyDocument");
  if (p.type === "propose_memory") return t("chat.proposal.whyMemory");
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
  const t = useT();
  const family = useIsFamily();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function post(action: "approve" | "always" | "deny" | "undo") {
    const res = await fetch(`/api/chat/${conversationId}/proposals/${proposal.n}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messageId, action }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(typeof body.error === "string" ? body.error : t("chat.errors.retry"));
    return body as { status: ProposalView["status"]; result: ProposalView["result"]; label?: string; href?: string };
  }

  async function decide(d: Decision) {
    const body = await post(d);
    // Let the card show its confirmation, then settle into the quiet line with Undo.
    window.setTimeout(() => onDecided({ ...proposal, status: body.status, result: body.result ?? null, auto: null }), 900);
    return { ok: true, label: body.label ? resultWords(body.label, t) : d === "deny" ? undefined : t("chat.proposal.savedDot"), href: body.href };
  }

  async function undo() {
    setBusy(true); setError(null);
    try {
      const body = await post("undo");
      onDecided({ ...proposal, status: body.status, result: body.result ?? proposal.result ?? null });
    } catch (e) {
      setError(e instanceof Error ? e.message : t("chat.errors.short"));
    } finally {
      setBusy(false);
    }
  }

  if (proposal.status === "pending") {
    return (
      <ApprovalCard
        title={titleOf(proposal, t, family)} kindLabel={t(`chat.proposal.kind.${proposal.type}`)} why={why(proposal, t)} preview={<Preview p={proposal} />}
        citations={proposal.basis === "document" ? citations : []}
        alwaysLabel={proposal.basis === "document" || proposal.widens ? undefined : t(`chat.proposal.always.${proposal.type}`)}
        onDecide={decide}
      />
    );
  }

  async function settleNow(action: "approve" | "deny") {
    setBusy(true); setError(null);
    try {
      const body = await post(action);
      onDecided({ ...proposal, status: body.status, result: body.result ?? null, auto: null, keeperNote: null });
    } catch (e) {
      setError(e instanceof Error ? e.message : t("chat.errors.short"));
    } finally {
      setBusy(false);
    }
  }

  if (proposal.status === "queued") {
    // Memory is the Brain Keeper's: it decides on its next run. The person can still decide now.
    return (
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.18, ease: EASE }} role="status"
        className="flex flex-wrap items-center gap-x-2 gap-y-1 px-1 py-1 text-sm text-muted">
        <Bookmark aria-hidden className="size-4" />
        <span className="min-w-0">{t("chat.proposal.queued")} <span className="text-fg">{summary(proposal)}</span></span>
        <span className="inline-flex items-center gap-1">
          <button type="button" onClick={() => void settleNow("approve")} disabled={busy}
            className="inline-flex h-7 items-center rounded-md px-1.5 text-fg transition-colors hover:bg-surface-2 disabled:opacity-60">{t("chat.proposal.rememberNow")}</button>
          <button type="button" onClick={() => void settleNow("deny")} disabled={busy}
            className="inline-flex h-7 items-center rounded-md px-1.5 transition-colors hover:bg-surface-2 hover:text-fg disabled:opacity-60">{t("chat.proposal.dontKeep")}</button>
        </span>
        {proposal.keeperNote && <span className="w-full text-xs">{proposal.keeperNote}</span>}
        {error && <span role="alert" className="w-full text-danger">{error}</span>}
      </motion.div>
    );
  }

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.18, ease: EASE }} role="status"
      className="flex flex-wrap items-center gap-x-2 gap-y-1 px-1 py-1 text-sm text-muted">
      {proposal.status === "approved" ? (
        <>
          {proposal.type === "propose_memory" ? <Bookmark aria-hidden className="size-4 text-accent" /> : <Check aria-hidden className="size-4 text-accent" />}
          <span className="min-w-0">
            {proposal.auto === "always" && <>{t("chat.proposal.savedAlways")} </>}
            {proposal.auto === "keeper" && <>{t("chat.proposal.keeperKept")} </>}
            {proposal.result?.href
              ? <a className="text-fg underline decoration-line underline-offset-4 hover:decoration-accent" href={proposal.result.href}>{resultWords(proposal.result.label, t)}</a>
              : <span className={proposal.auto === "setting" ? "" : "text-fg"}>{resultWords(proposal.result?.label, t)}</span>}
          </span>
          {proposal.result?.undo && (
            <button type="button" onClick={undo} disabled={busy}
              className="inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-fg transition-colors hover:bg-surface-2 disabled:opacity-60">
              <Undo2 aria-hidden className="size-3.5" />{busy ? t("chat.proposal.undoing") : t("chat.proposal.undo")}
            </button>
          )}
        </>
      ) : proposal.status === "undone" ? (
        <><Undo2 aria-hidden className="size-4" /><span className="min-w-0">{t("chat.proposal.undone", { what: summary(proposal) })}</span></>
      ) : (
        <><Undo2 aria-hidden className="size-4" /><span className="min-w-0">{t(proposal.auto === "keeper" ? "chat.proposal.keeperDidnt" : "chat.proposal.notSaved", { what: summary(proposal) })}</span></>
      )}
      {proposal.auto === "keeper" && proposal.keeperNote && proposal.status !== "undone" && <span className="w-full text-xs">{proposal.keeperNote}</span>}
      {error && <span role="alert" className="w-full text-danger">{error}</span>}
    </motion.div>
  );
}
