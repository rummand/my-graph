"use client";
import { useState } from "react";
import { motion } from "motion/react";
import { ArrowUp } from "lucide-react";
import type { Clarify } from "@/lib/assistant/clarify";
import { SKIP_TEXT } from "@/lib/assistant/clarify";
import { useT } from "@/lib/i18n/client";

const EASE = [0.22, 1, 0.36, 1] as const;

/** A clarifying question from the assistant: preset choices, your own answer, or Skip (continue with what it knows). */
export function ClarifyPicker({ clarify, active, onAnswer }: { clarify: Clarify; active: boolean; onAnswer: (text: string) => void }) {
  const t = useT();
  const [text, setText] = useState("");
  if (!active) {
    return <p className="mt-4 text-sm text-muted">{t("chat.clarify.asked", { q: clarify.question })}</p>;
  }
  return (
    <motion.div initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2, ease: EASE }}
      role="group" aria-label={clarify.question} className="mt-5 rounded-lg bg-surface p-4">
      <p className="flex items-center gap-2 font-medium">
        <span aria-hidden className="size-1.5 rounded-full bg-warn" />{clarify.question}
      </p>
      {clarify.choices.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {clarify.choices.map((c) => (
            <button key={c} type="button" onClick={() => onAnswer(c)}
              className="h-8 rounded-full bg-surface-2 px-3.5 text-sm text-fg transition-[background-color,transform] hover:bg-line active:scale-[0.97]">
              {c}
            </button>
          ))}
        </div>
      )}
      <form className="mt-3 flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); if (text.trim()) onAnswer(text.trim()); }}>
        <label htmlFor="clarify-own" className="sr-only">{t("chat.clarify.own")}</label>
        <input id="clarify-own" value={text} onChange={(e) => setText(e.target.value)} maxLength={400} placeholder={t("chat.clarify.placeholder")}
          className="h-8 min-w-0 flex-1 rounded-md border border-line bg-bg px-2.5 text-sm outline-none placeholder:text-muted/80 focus-visible:border-accent" />
        <button type="submit" disabled={!text.trim()} aria-label={t("chat.clarify.send")}
          className="inline-flex size-8 items-center justify-center rounded-md bg-fg text-bg transition-transform active:scale-[0.94] disabled:bg-surface-2 disabled:text-muted">
          <ArrowUp aria-hidden className="size-4" />
        </button>
        <button type="button" onClick={() => onAnswer(SKIP_TEXT)}
          className="h-8 rounded-md px-2.5 text-sm text-muted transition-colors hover:bg-surface-2 hover:text-fg">
          {t("chat.clarify.skip")}
        </button>
      </form>
      <p className="mt-2 text-xs text-muted">{t("chat.clarify.skipHint")}</p>
    </motion.div>
  );
}
