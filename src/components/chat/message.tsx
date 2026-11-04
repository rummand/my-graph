"use client";
import { useState } from "react";
import { motion } from "motion/react";
import Link from "next/link";
import { Check, Copy, GitPullRequestArrow, ThumbsDown, ThumbsUp } from "lucide-react";
import { clsx } from "clsx";
import { useFormatDate, useT } from "@/lib/i18n/client";
import { MentionText } from "@/components/mention/mention-text";
import { parseMentions } from "@/lib/mentions/markup";
import type { Citation } from "@/db/schema";
import type { MessageView } from "@/lib/assistant/store";
import type { ProposalView } from "@/lib/assistant/proposals";
import { Markdown } from "./markdown";
import { SourceList } from "./citation";
import { ProposalCard } from "./proposal-card";
import { shortModel } from "./recency";
import { ClarifyPicker } from "./clarify-picker";
import { LiveSteps, WorkedLine } from "./work-steps";
import { AnswerCompliance } from "@/components/compliance/answer";

export type UiMessage = MessageView & { uid: string; streaming?: boolean; live?: Citation[]; fresh?: boolean };

const EASE = [0.22, 1, 0.36, 1] as const;


/** A question reads as the heading of the answer under it: the thread is a document you read top to bottom. */
export function Question({ m, first }: { m: UiMessage; first: boolean }) {
  return (
    <motion.h2
      initial={m.fresh ? { opacity: 0, y: 8 } : false} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22, ease: EASE }}
      className={`${first ? "" : "mt-16"} whitespace-pre-wrap break-words text-[21px]/[1.35] font-semibold tracking-[-0.015em]`}>
      {parseMentions(m.content).length ? <MentionText text={m.content} /> : m.content}
    </motion.h2>
  );
}

export function Answer({ m, conversationId, onDecided, canClarify, onClarify, onFeedback }: {
  m: UiMessage; conversationId: string | null; onDecided: (messageId: string, p: ProposalView) => void;
  /** The latest answer, and nothing is being written: its clarifying question can be answered. */
  canClarify: boolean;
  onClarify: (text: string) => void;
  onFeedback: (messageId: string, value: 1 | -1 | null) => void;
}) {
  const citations = m.streaming ? m.live ?? [] : m.citations;
  return (
    <motion.article
      initial={m.fresh ? { opacity: 0 } : false} animate={{ opacity: 1 }} transition={{ duration: 0.2, ease: EASE }}
      className="mt-4" aria-busy={m.streaming || undefined}>
      {m.streaming && !m.content ? (
        <LiveSteps steps={m.steps} writing={false} />
      ) : (
        <>
          <WorkedLine steps={m.steps} thoughtMs={m.thoughtMs} streaming={m.streaming} />
          <Markdown text={m.content} citations={citations} caret={m.streaming} />
        </>
      )}

      {!m.streaming && m.clarify && (
        <ClarifyPicker clarify={m.clarify} active={canClarify} onAnswer={onClarify} />
      )}

      {!m.streaming && m.citations.length > 0 && <SourceList citations={m.citations} />}

      {!m.streaming && conversationId && m.proposals.length > 0 && (
        <div className="mt-6 space-y-2">
          {m.proposals.map((p) => (
            <ProposalCard key={p.n} conversationId={conversationId} messageId={m.id} proposal={p} citations={m.citations} onDecided={(x) => onDecided(m.id, x)} />
          ))}
        </div>
      )}

      {!m.streaming && <ProposedChanges steps={m.steps} />}

      {!m.streaming && m.content && !m.clarify && <AnswerCompliance messageId={m.id} createdAt={m.createdAt} />}

      {!m.streaming && m.content && <AnswerMeta m={m} onFeedback={conversationId && !m.id.startsWith("local-") && m.id !== "pending" ? onFeedback : undefined} />}
    </motion.article>
  );
}

/** What the assistant proposed while answering (facts read on the web): waits on /changes for a person to deliver. */
function ProposedChanges({ steps }: { steps: UiMessage["steps"] }) {
  const t = useT();
  const step = steps.find((s) => s.changeSetId);
  if (!step?.changeSetId) return null;
  return (
    <Link href={`/changes/${step.changeSetId}`}
      className="mt-6 flex items-center justify-between gap-3 rounded-lg bg-surface px-4 py-3 text-sm transition-colors hover:bg-surface-2">
      <span className="inline-flex items-center gap-2">
        <GitPullRequestArrow aria-hidden className="size-4 text-accent" />
        {t("chat.message.proposedChanges", { count: step.count ?? 1 })}
      </span>
      <span className="font-medium text-accent">{t("chat.message.reviewChanges")}</span>
    </Link>
  );
}

function AnswerMeta({ m, onFeedback }: { m: UiMessage; onFeedback?: (messageId: string, value: 1 | -1 | null) => void }) {
  const t = useT();
  const fmt = useFormatDate();
  const [copied, setCopied] = useState(false);
  const model = shortModel(m.model);
  const route = t(`chat.message.route.${m.route ?? "auto"}`, undefined, t("chat.message.answer"));
  const when = new Date(m.createdAt);
  async function copy() {
    try {
      await navigator.clipboard.writeText(m.content.replace(/\s?\[\d+(?:\s*,\s*\d+)*\]/g, ""));
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch { /* clipboard blocked: nothing to do */ }
  }
  return (
    <div className="mt-5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
      <button type="button" onClick={copy}
        className="-ml-1.5 inline-flex h-7 items-center gap-1.5 rounded-md px-1.5 transition-colors hover:bg-surface-2 hover:text-fg">
        {copied ? <Check aria-hidden className="size-3.5 text-accent" /> : <Copy aria-hidden className="size-3.5" />}
        {copied ? t("chat.message.copied") : t("chat.message.copy")}
      </button>
      {onFeedback && (
        <span className="inline-flex items-center" role="group" aria-label={t("chat.message.helpful")}>
          <FeedbackButton label={t("chat.message.good")} pressed={m.feedback === 1} onClick={() => onFeedback(m.id, m.feedback === 1 ? null : 1)}><ThumbsUp className="size-3.5" /></FeedbackButton>
          <FeedbackButton label={t("chat.message.bad")} pressed={m.feedback === -1} onClick={() => onFeedback(m.id, m.feedback === -1 ? null : -1)}><ThumbsDown className="size-3.5" /></FeedbackButton>
        </span>
      )}
      {(m.route || model) && (
        <span className="inline-flex items-center gap-1" title={m.model ?? undefined}>
          {model ? t("chat.message.from", { route, model }) : route}
        </span>
      )}
      {!Number.isNaN(when.getTime()) && <time dateTime={m.createdAt} suppressHydrationWarning>{fmt(when, "weekday")}, {fmt(when, "time")}</time>}
    </div>
  );
}

function FeedbackButton({ label, pressed, onClick, children }: { label: string; pressed: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} aria-pressed={pressed} onClick={onClick}
      className={clsx("inline-flex size-7 items-center justify-center rounded-md transition-[background-color,color,transform] active:scale-[0.92]",
        pressed ? "bg-accent-tint text-accent" : "hover:bg-surface-2 hover:text-fg")}>
      {children}
    </button>
  );
}
