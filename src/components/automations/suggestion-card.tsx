"use client";
import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowRight, Check } from "lucide-react";
import { ApprovalCard, type Decision } from "@/components/assistant/approval-card";
import { Button, CitationChip } from "@/components/ui";
import type { Suggestion } from "@/lib/automations";
import { alwaysLabelFor } from "@/lib/automations/policy";
import type { TFn } from "@/lib/i18n/client";
import { MentionText } from "@/components/mention";
import { api, useCopy } from "./bits";

export type SuggestionView = Omit<Suggestion, "createdAt"> & { createdAt: string };

function originLabel(s: SuggestionView, t: TFn, whenInline: (iso: string) => string): string {
  return t(`automations.suggestion.origin.${s.origin}`, { when: whenInline(s.createdAt) });
}

const str = (x: unknown) => (typeof x === "string" ? x : "");

/** Exactly what approving would write, in plain words. */
function Preview({ s }: { s: SuggestionView }) {
  const { t, whenInline } = useCopy();
  const p = s.payload;
  switch (s.kind) {
    case "reminder":
      return <p><span className="font-medium">{str(p.title)}</span>{p.dueAt ? <span className="text-muted">{t("automations.suggestion.due", { when: whenInline(str(p.dueAt)) })}</span> : null}{p.detail ? <span className="mt-1 block text-muted">{str(p.detail)}</span> : null}</p>;
    case "memory": case "rule":
      return <p><MentionText text={str(p.text)} /></p>;
    case "wiki_edit":
      return <div><p className="font-medium">{str(p.slug) ? t("automations.suggestion.addTo", { title: str(p.title) }) : t("automations.suggestion.newPage", { title: str(p.title) })}</p><p className="mt-1 line-clamp-4 whitespace-pre-line text-muted">{str(p.text)}</p></div>;
    case "merge":
      return <p>{t("automations.suggestion.merge")}</p>;
    case "fact":
      return p.edgeId ? <p>{t("automations.suggestion.confirmFact")}</p>
        : <p>{[(p.from as { label?: string })?.label ?? "", str(p.relation).replace(/_/g, " "), (p.to as { label?: string })?.label ?? ""].filter(Boolean).join(" ")}</p>;
    default:
      return null;
  }
}

/** One inbox item: an approval card for anything that writes, a plain heads-up for nudges. */
export function SuggestionCard({ s, onDone, compact }: { s: SuggestionView; onDone?: (id: string) => void; compact?: boolean }) {
  const { t, whenInline } = useCopy();
  const decide = async (d: Decision) => {
    const r = await api<{ ok: boolean; href?: string; label?: string }>(`/api/suggestions/${s.id}`, { method: "POST", json: { decision: d } });
    setTimeout(() => onDone?.(s.id), 2500);
    return r;
  };
  if (s.kind === "nudge") return <NudgeCard s={s} decide={decide} onDone={onDone} />;
  return (
    <ApprovalCard compact={compact} title={s.title} why={s.body ?? undefined} preview={<Preview s={s} />} citations={s.citations}
      kindLabel={t(`automations.suggestion.kind.${s.kind}`)} origin={originLabel(s, t, whenInline)}
      alwaysLabel={alwaysLabelFor(s.kind) ? t(`automations.suggestion.always.${s.kind}`, undefined, alwaysLabelFor(s.kind) ?? undefined) : undefined} onDecide={decide} />
  );
}

function NudgeCard({ s, decide, onDone }: { s: SuggestionView; decide: (d: Decision) => Promise<unknown>; onDone?: (id: string) => void }) {
  const { t, whenInline } = useCopy();
  const [state, setState] = useState<"idle" | "busy" | "done" | "dismissed">("idle");
  const [error, setError] = useState<string | null>(null);
  const href = typeof s.payload.href === "string" && s.payload.href.startsWith("/") ? s.payload.href : null;
  const act = async (d: Decision) => {
    setState("busy"); setError(null);
    try {
      await decide(d);
      setState(d === "deny" ? "dismissed" : "done");
    } catch (e) {
      setError(e instanceof Error ? e.message : t("automations.suggestion.failed"));
      setState("idle");
    }
  };
  return (
    <motion.div layout className="rounded-lg bg-surface p-3">
      <AnimatePresence mode="wait" initial={false}>
        {state === "done" || state === "dismissed" ? (
          <motion.p key="d" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex items-center gap-2 text-sm text-muted">
            <Check className="size-4" aria-hidden />{state === "dismissed" ? t("automations.suggestion.dismissed") : t("automations.suggestion.seen")}
            <button className="ml-auto text-accent hover:underline" onClick={() => onDone?.(s.id)}>{t("automations.suggestion.hide")}</button>
          </motion.p>
        ) : (
          <motion.div key="a" exit={{ opacity: 0 }}>
            <p className="mb-0.5 text-xs text-muted">{originLabel(s, t, whenInline)}</p>
            <p className="font-medium">{s.title}</p>
            {s.body && <p className="mt-0.5 text-sm text-muted">{s.body}</p>}
            {s.citations.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {s.citations.slice(0, 4).map((c) => <CitationChip key={c.n} n={c.n} title={c.title} href={c.sourceId ? `/library/${c.sourceId}` : c.nodeId ? `/node/${c.nodeId}` : undefined} />)}
              </div>
            )}
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              {href && <a href={href} onClick={() => void act("approve")} className="inline-flex h-8 items-center gap-1.5 rounded-md bg-fg px-2.5 text-sm font-medium text-bg hover:bg-fg/85">
                {typeof s.payload.label === "string" ? s.payload.label : t("automations.suggestion.open")}<ArrowRight className="size-3.5" aria-hidden /></a>}
              {!href && <Button size="sm" onClick={() => act("approve")} disabled={state === "busy"}>{t("automations.suggestion.gotIt")}</Button>}
              <Button size="sm" variant="ghost" onClick={() => act("deny")} disabled={state === "busy"}>{t("automations.suggestion.dontRemind")}</Button>
              {error && <span role="alert" className="text-sm text-danger">{error}</span>}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
