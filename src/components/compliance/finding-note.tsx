"use client";
/**
 * One compliance note: which rule, why, the rule's own words with a link to its source, and what to do — "Suggest a
 * fix" (shown as a pending edit to accept) or "Accept deviation" (asks for the reason, which is kept in history).
 * Advisory: it never blocks, it always says why and where the rule comes from.
 */
import { useId, useState } from "react";
import Link from "next/link";
import { clsx } from "clsx";
import { AlertOctagon, AlertTriangle, CheckCircle2, ExternalLink, HelpCircle, Info, Wand2, X } from "lucide-react";
import { Button, Textarea } from "@/components/ui";
import { useT } from "@/lib/i18n/client";
import { decideFinding, sourceHref, type FindingView } from "./api";

export function severityTone(f: Pick<FindingView, "rule" | "status" | "verdict">): "danger" | "warn" | "muted" {
  if (f.status === "accepted") return "muted";
  if (f.rule.severity === "blocker") return "danger";
  if (f.rule.severity === "info") return "muted";
  return "warn";
}

export function FindingIcon({ f, className }: { f: FindingView; className?: string }) {
  const tone = severityTone(f);
  const cls = clsx("shrink-0", tone === "danger" ? "text-danger" : tone === "warn" ? "text-warn" : "text-muted", className);
  if (f.status === "accepted") return <CheckCircle2 aria-hidden className={cls} />;
  if (f.verdict === "unclear") return <HelpCircle aria-hidden className={cls} />;
  if (f.rule.severity === "blocker") return <AlertOctagon aria-hidden className={cls} />;
  if (f.rule.severity === "info") return <Info aria-hidden className={cls} />;
  return <AlertTriangle aria-hidden className={cls} />;
}

/** "Doesn't meet BEK 260 §16 stk. 2". */
export function findingHeadline(t: ReturnType<typeof useT>, f: FindingView): string {
  const ref = `${f.rule.corpusName} ${f.rule.ref}`;
  if (f.verdict === "missing") return t("compliance.finding.missing", { ref });
  if (f.verdict === "unclear") return t("compliance.finding.unclear", { ref });
  return t("compliance.finding.nonCompliant", { ref });
}

export function FindingNote({ f, canEdit, onSuggest, onChanged, onClose, compact = false, pending }: {
  f: FindingView;
  canEdit: boolean;
  /** Show "Suggest a fix"; called with the finding (the editor shows it as a pending edit). */
  onSuggest?: (f: FindingView) => void;
  /** After accept / undo: the target's findings as they now stand. */
  onChanged?: (findings: FindingView[]) => void;
  onClose?: () => void;
  compact?: boolean;
  /** The suggested fix is showing as a pending edit: accept or discard it here. */
  pending?: { onAccept: () => void; onDiscard: () => void; manual?: boolean } | null;
}) {
  const t = useT();
  const id = useId();
  const [accepting, setAccepting] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const href = sourceHref(f);

  async function keep() {
    setBusy(true); setError(null);
    const r = await decideFinding(f.id, { action: "accept", reason });
    setBusy(false);
    if (!r.ok) { setError(r.error || t("compliance.errors.failed")); return; }
    setAccepting(false);
    onChanged?.(r.data.findings);
  }
  async function undo() {
    setBusy(true);
    const r = await decideFinding(f.id, { action: "reopen" });
    setBusy(false);
    if (r.ok) onChanged?.(r.data.findings);
  }

  return (
    <div className={clsx("text-sm", !compact && "rounded-lg bg-surface p-4 shadow-float")} role="group" aria-labelledby={`${id}-h`}>
      <div className="flex items-start gap-2">
        <FindingIcon f={f} className="mt-0.5 size-4" />
        <div className="min-w-0 flex-1">
          <p id={`${id}-h`} className="font-medium text-fg">{findingHeadline(t, f)}</p>
          <p className="text-xs text-muted">{t(`compliance.severity.${f.rule.severity}`)}{f.rule.title ? `, ${f.rule.title}` : ""}</p>
        </div>
        {onClose && (
          <button type="button" onClick={onClose} aria-label={t("compliance.finding.close")} className="-mr-1 -mt-1 rounded-md p-1 text-muted hover:bg-surface-2 hover:text-fg">
            <X className="size-4" aria-hidden />
          </button>
        )}
      </div>

      {f.explanation && <p className="mt-2 text-fg">{f.explanation}</p>}

      {f.span && f.verdict !== "missing" && (
        <p className="mt-2 text-muted">
          <span className="sr-only">{t("compliance.finding.passage")}: </span>
          {f.span.approx ? <span className="italic">{t("compliance.finding.approx")}: </span> : null}
          <span className={clsx("rounded-[2px] px-0.5", severityTone(f) === "danger" ? "bg-danger-tint" : "bg-warn-tint")}>{f.span.text.length > 220 ? `${f.span.text.slice(0, 219)}…` : f.span.text}</span>
        </p>
      )}

      <div className="mt-3 border-l-2 border-line pl-3">
        <p className="text-xs text-muted">{t("compliance.finding.rule")}, {f.rule.corpusName} {f.rule.ref}</p>
        <p className="mt-0.5">{f.rule.text}</p>
        {f.rule.quote && <blockquote lang="da" className="mt-1.5 font-read text-[14px] italic leading-relaxed text-muted">“{f.rule.quote.length > 400 ? `${f.rule.quote.slice(0, 399)}…` : f.rule.quote}”</blockquote>}
        {href ? (
          <Link href={href} className="mt-1.5 inline-flex items-center gap-1 text-xs text-accent hover:underline">
            <ExternalLink aria-hidden className="size-3" />{t("compliance.finding.openSource", { title: f.rule.sourceTitle ?? f.rule.corpusName })}
          </Link>
        ) : f.rule.quote === null && !f.rule.sourceId ? null : <p className="mt-1 text-xs text-muted">{t("compliance.finding.hiddenSource")}</p>}
      </div>

      {f.status === "accepted" ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-muted">
          <CheckCircle2 aria-hidden className="size-4" />
          <span className="min-w-0 flex-1">{f.acceptedByName ? t("compliance.finding.accepted", { name: f.acceptedByName, reason: f.acceptedReason ?? "" }) : t("compliance.finding.acceptedNoName", { reason: f.acceptedReason ?? "" })}</span>
          {canEdit && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void undo()}>{t("compliance.finding.reopen")}</Button>}
        </div>
      ) : pending ? (
        <div className="mt-3 rounded-md bg-accent-tint/60 p-3">
          <p className="text-xs font-medium text-accent">{pending.manual ? t("compliance.finding.fixByHand") : t("compliance.finding.fixPending")}</p>
          {f.suggestion && <p className="mt-1 whitespace-pre-wrap text-fg">{f.suggestion}</p>}
          <div className="mt-2 flex flex-wrap gap-2">
            {!pending.manual && <Button size="sm" onClick={pending.onAccept}>{t("compliance.finding.acceptFix")}</Button>}
            <Button size="sm" variant="ghost" onClick={pending.onDiscard}>{pending.manual ? t("compliance.finding.close") : t("compliance.finding.discardFix")}</Button>
          </div>
        </div>
      ) : canEdit && !accepting ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {onSuggest && f.suggestion && <Button size="sm" variant="secondary" onClick={() => onSuggest(f)}><Wand2 aria-hidden className="size-3.5" />{t("compliance.finding.suggestFix")}</Button>}
          <Button size="sm" variant="ghost" onClick={() => setAccepting(true)}>{t("compliance.finding.accept")}</Button>
        </div>
      ) : null}

      {accepting && (
        <form className="mt-3 grid gap-2" onSubmit={(e) => { e.preventDefault(); void keep(); }}>
          <p className="font-medium">{t("compliance.finding.acceptTitle")}</p>
          <p className="text-xs text-muted">{t("compliance.finding.acceptLead")}</p>
          <label htmlFor={`${id}-reason`} className="sr-only">{t("compliance.finding.reason")}</label>
          <Textarea id={`${id}-reason`} rows={2} value={reason} autoFocus placeholder={t("compliance.finding.reasonPlaceholder")} onChange={(e) => setReason(e.target.value)} />
          {error && <p role="alert" className="text-xs text-danger">{error}</p>}
          <div className="flex gap-2">
            <Button size="sm" type="submit" disabled={busy || reason.trim().length < 5}>{t("compliance.finding.keep")}</Button>
            <Button size="sm" variant="ghost" type="button" onClick={() => setAccepting(false)}>{t("compliance.finding.cancel")}</Button>
          </div>
        </form>
      )}
    </div>
  );
}
