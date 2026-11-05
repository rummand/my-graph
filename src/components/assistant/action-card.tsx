"use client";
import { motion } from "motion/react";
import { Check, Loader2, MousePointerClick, X } from "lucide-react";
import { useT } from "@/lib/i18n/client";
import { ApprovalCard } from "./approval-card";

/** A page action the assistant called in this answer, as the window shows it. */
export type ActionView = {
  callId: string;
  title: string;
  /** The approval question ("Move 3 files to Money › Tax?"). */
  question: string;
  preview: string | null;
  danger: "read" | "change";
  status: "asking" | "running" | "done" | "declined" | "failed" | "unavailable";
  summary?: string | null;
  error?: string | null;
};

const EASE = [0.22, 1, 0.36, 1] as const;

/**
 * A change on the page waits for the person: an approval card ("Approve" / "Not now"). Reading and navigating run at
 * once and show as one quiet line.
 */
export function PageActionCard({ a, onDecide }: {
  a: ActionView;
  /** Resolves when the action has run (approve) or was dropped (deny). */
  onDecide: (callId: string, approve: boolean) => Promise<{ ok: boolean; label?: string }>;
}) {
  const t = useT();
  if (a.danger === "change" && (a.status === "asking" || a.status === "running")) {
    return (
      <ApprovalCard compact className="mt-3" kindLabel={t("chat.actions.onThisPage")} title={a.question}
        preview={a.preview ? <p className="whitespace-pre-line">{a.preview}</p> : undefined}
        labels={{ approve: t("chat.actions.approve"), deny: t("chat.actions.notNow"), busy: t("chat.actions.doing"), dismissed: t("chat.actions.dropped") }}
        onDecide={async (d) => onDecide(a.callId, d !== "deny")} />
    );
  }
  const icon = a.status === "running" || a.status === "asking"
    ? <Loader2 aria-hidden className="size-3.5 animate-spin" />
    : a.status === "done" ? <Check aria-hidden className="size-3.5 text-accent" />
      : a.status === "declined" ? <X aria-hidden className="size-3.5" />
        : <MousePointerClick aria-hidden className="size-3.5 text-warn" />;
  const tail = a.status === "done" ? a.summary
    : a.status === "declined" ? t("chat.actions.dropped")
      : a.status === "failed" ? a.error || t("chat.actions.failed")
        : a.status === "unavailable" ? t("chat.actions.unavailable") : null;
  return (
    <motion.p initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.18, ease: EASE }}
      className="mt-3 flex items-start gap-2 rounded-md bg-surface-2 px-3 py-2 text-sm text-muted">
      <span className="mt-0.5 shrink-0">{icon}</span>
      <span className="min-w-0">
        <span className="text-fg">{a.danger === "change" ? a.question : a.title}</span>
        {tail && <span className={a.status === "failed" ? "text-danger" : undefined}> · {tail}</span>}
      </span>
    </motion.p>
  );
}
