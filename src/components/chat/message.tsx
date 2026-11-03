"use client";
import { useState } from "react";
import { motion } from "motion/react";
import { Check, Copy, Lock } from "lucide-react";
import { format } from "date-fns";
import type { Citation } from "@/db/schema";
import type { MessageView } from "@/lib/assistant/store";
import type { ProposalView } from "@/lib/assistant/proposals";
import { Markdown } from "./markdown";
import { SourceList } from "./citation";
import { ProposalCard } from "./proposal-card";
import { shortModel } from "./recency";

export type UiMessage = MessageView & { uid: string; streaming?: boolean; live?: Citation[]; fresh?: boolean };

const EASE = [0.22, 1, 0.36, 1] as const;

const ROUTE_LABEL: Record<string, string> = {
  fast: "Quick answer", smart: "Careful answer", agent: "Answered on a local model", auto: "Answer",
};

/** A question reads as the heading of the answer under it: the thread is a document you read top to bottom. */
export function Question({ m, first }: { m: UiMessage; first: boolean }) {
  return (
    <motion.h2
      initial={m.fresh ? { opacity: 0, y: 8 } : false} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22, ease: EASE }}
      className={`${first ? "" : "mt-16"} whitespace-pre-wrap break-words text-[21px]/[1.35] font-semibold tracking-[-0.015em]`}>
      {m.content}
    </motion.h2>
  );
}

export function Answer({ m, conversationId, onDecided }: {
  m: UiMessage; conversationId: string | null; onDecided: (messageId: string, p: ProposalView) => void;
}) {
  const citations = m.streaming ? m.live ?? [] : m.citations;
  return (
    <motion.article
      initial={m.fresh ? { opacity: 0 } : false} animate={{ opacity: 1 }} transition={{ duration: 0.2, ease: EASE }}
      className="mt-4" aria-busy={m.streaming || undefined}>
      {m.content ? (
        <Markdown text={m.content} citations={citations} caret={m.streaming} />
      ) : (
        <Thinking found={m.live?.length ?? 0} />
      )}

      {!m.streaming && m.citations.length > 0 && <SourceList citations={m.citations} />}

      {!m.streaming && conversationId && m.proposals.length > 0 && (
        <div className="mt-6 space-y-2">
          {m.proposals.map((p) => (
            <ProposalCard key={p.n} conversationId={conversationId} messageId={m.id} proposal={p} onDecided={(x) => onDecided(m.id, x)} />
          ))}
        </div>
      )}

      {!m.streaming && m.content && <AnswerMeta m={m} />}
    </motion.article>
  );
}

function Thinking({ found }: { found: number }) {
  return (
    <p className="flex items-center gap-2.5 text-muted" role="status">
      <span className="inline-flex gap-1" aria-hidden>
        {[0, 1, 2].map((i) => (
          <motion.span key={i} className="size-1.5 rounded-full bg-muted"
            animate={{ opacity: [0.25, 1, 0.25] }} transition={{ duration: 1.2, repeat: Infinity, delay: i * 0.16, ease: "easeInOut" }} />
        ))}
      </span>
      {found > 0
        ? <span>Found {found} {found === 1 ? "thing" : "things"} in your graph. Writing the answer…</span>
        : <span>Looking through your graph…</span>}
    </p>
  );
}

function AnswerMeta({ m }: { m: UiMessage }) {
  const [copied, setCopied] = useState(false);
  const model = shortModel(m.model);
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
        {copied ? "Copied" : "Copy answer"}
      </button>
      {(m.route || model) && (
        <span className="inline-flex items-center gap-1" title={m.model ?? undefined}>
          {m.route === "agent" && <Lock aria-hidden className="size-3" />}
          {ROUTE_LABEL[m.route ?? ""] ?? "Answer"}{model ? ` from ${model}` : ""}
        </span>
      )}
      {!Number.isNaN(when.getTime()) && <time dateTime={m.createdAt}>{format(when, "EEE d MMM, HH:mm")}</time>}
    </div>
  );
}
