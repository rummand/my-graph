"use client";
/** One rule: its reference, the rule in plain words, the exact words of the source with a link, and (for people who
 * may decide) Approve / Edit / Drop for proposed rules, Edit / Retire for rules in use. */
import { useState } from "react";
import Link from "next/link";
import { clsx } from "clsx";
import { ExternalLink } from "lucide-react";
import { Badge, Button, Field, Input, Select, Textarea } from "@/components/ui";
import { useT } from "@/lib/i18n/client";
import { MODALITIES, SEVERITIES } from "@/lib/corpus/pure";
import type { RuleView } from "@/lib/corpus";

export type RuleEdit = { ref: string; title: string; text: string; modality: string; severity: string; checkHint: string };

export function ruleSourceHref(r: Pick<RuleView, "sourceId" | "locator"> & { chunkId?: string | null }): string | null {
  if (!r.sourceId) return null;
  if (r.chunkId) return `/library/${r.sourceId}#chunk-${r.chunkId}`;
  return `/library/${r.sourceId}${typeof r.locator?.page === "number" ? `#page=${r.locator.page}` : ""}`;
}

export function RuleForm({ initial, onSave, onCancel, withQuote = false }: { initial: RuleEdit & { quote?: string }; onSave: (v: RuleEdit & { quote?: string }) => Promise<string | null>; onCancel: () => void; withQuote?: boolean }) {
  const t = useT();
  const [v, setV] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof v, val: string) => setV((x) => ({ ...x, [k]: val }));
  return (
    <form className="grid gap-3" onSubmit={async (e) => { e.preventDefault(); setBusy(true); setError(null); const err = await onSave(v); setBusy(false); if (err) setError(err); }}>
      <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
        <Field label={t("corpus.rules.ref")}><Input required value={v.ref} placeholder={t("corpus.rules.refPlaceholder")} maxLength={80} onChange={(e) => set("ref", e.target.value)} /></Field>
        <Field label={t("corpus.rules.ruleTitle")}><Input value={v.title} maxLength={160} onChange={(e) => set("title", e.target.value)} /></Field>
      </div>
      <Field label={t("corpus.rules.text")}><Textarea required rows={2} value={v.text} maxLength={800} placeholder={t("corpus.rules.textPlaceholder")} onChange={(e) => set("text", e.target.value)} /></Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t("corpus.rules.modality")}>
          <Select value={v.modality} onChange={(e) => set("modality", e.target.value)}>{MODALITIES.map((m) => <option key={m} value={m}>{t(`corpus.modality.${m}`)}</option>)}</Select>
        </Field>
        <Field label={t("corpus.rules.severity")}>
          <Select value={v.severity} onChange={(e) => set("severity", e.target.value)}>{SEVERITIES.map((s) => <option key={s} value={s}>{t(`corpus.severity.${s}`)}</option>)}</Select>
        </Field>
      </div>
      <Field label={t("corpus.rules.checkHintLabel")}><Textarea rows={2} value={v.checkHint} maxLength={600} onChange={(e) => set("checkHint", e.target.value)} /></Field>
      {withQuote && <Field label={t("corpus.rules.quoteLabel")}><Textarea rows={2} value={v.quote ?? ""} maxLength={1600} onChange={(e) => set("quote", e.target.value)} /></Field>}
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy || v.text.trim().length < 8 || !v.ref.trim()}>{t("corpus.rules.save")}</Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>{t("corpus.rules.cancel")}</Button>
      </div>
    </form>
  );
}

const MOD_TONE: Record<string, "danger" | "warn" | "neutral" | "accent"> = { must: "neutral", must_not: "neutral", should: "neutral", should_not: "neutral", may: "neutral" };

export function RuleCard({ r, canManage, replaces, onDecide, onEdit, onRetire, busy, byUnit }: {
  r: RuleView; canManage: boolean;
  /** Rules of the set by the unit they were read from: cross-references link to them. */
  byUnit?: Map<string, RuleView>;
  /** For a changed rule: the words of the rule it replaces. */
  replaces?: string | null;
  onDecide?: (action: "approve" | "drop") => void;
  onEdit: (v: RuleEdit) => Promise<string | null>;
  onRetire?: (retire: boolean) => void;
  busy?: boolean;
}) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const href = ruleSourceHref(r);
  const proposed = r.status === "proposed";
  const retired = r.status === "retired";
  if (editing) {
    return (
      <div className="rounded-lg bg-surface p-4">
        <RuleForm initial={{ ref: r.ref, title: r.title, text: r.text, modality: r.modality, severity: r.severity, checkHint: r.checkHint ?? "" }}
          onCancel={() => setEditing(false)} onSave={async (v) => { const err = await onEdit(v); if (!err) setEditing(false); return err; }} />
      </div>
    );
  }
  return (
    <article id={`rule-${r.id}`} className={clsx("scroll-mt-24 rounded-lg p-4 target:ring-2 target:ring-accent", proposed ? "bg-warn-tint/40" : "bg-surface", retired && "opacity-60")} aria-label={`${r.ref} ${r.title}`}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="font-medium">{r.ref}</span>
        <span className="text-fg">{r.title}</span>
        <span className="ml-auto flex flex-wrap gap-1.5">
          {r.change && <Badge tone={r.change === "removed" ? "danger" : "warn"}>{t(`corpus.rules.change.${r.change}`)}</Badge>}
          {r.confidence != null && r.confidence < 0.55 && <Badge tone="inferred">{t("corpus.rule2.unsure")}</Badge>}
          <Badge tone={MOD_TONE[r.modality] ?? "neutral"}>{t(`corpus.modality.${r.modality}`)}</Badge>
          <Badge tone={r.severity === "blocker" ? "danger" : r.severity === "major" ? "warn" : "neutral"}>{t(`corpus.severity.${r.severity}`)}</Badge>
          {retired && <Badge>{t("corpus.rules.retired")}</Badge>}
        </span>
      </div>
      <p className={clsx("mt-1.5", r.change === "removed" && "line-through decoration-danger/60")}>{r.text}</p>
      {replaces && <p className="mt-1 text-sm text-muted">{t("corpus.rules.replaces", { text: replaces })}</p>}
      {r.change === "removed" && <p className="mt-1 text-sm text-muted">{t("corpus.rules.removedHint")}</p>}
      {r.quote && (
        <blockquote className="mt-2 border-l-2 border-line pl-3 font-read text-[14px] italic leading-relaxed text-muted">
          <span className="sr-only">{t("corpus.rules.quote")}: </span>“{r.quote}”
        </blockquote>
      )}
      {href ? (
        <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <Link href={href} className="inline-flex items-center gap-1 rounded-full bg-accent-tint px-2 py-0.5 text-accent hover:underline" title={r.sourceTitle ?? undefined}>
            {r.unitKey ? t("corpus.rule2.unit", { unit: r.unitKey }) : t("corpus.rule2.passage")}
          </Link>
          {r.pdf && <a href={`/api/files/${r.pdf.sourceId}#page=${r.pdf.page}`} target="_blank" rel="noreferrer" className="text-accent hover:underline">{t("corpus.rule2.pdfPage", { page: r.pdf.page })}</a>}
          {r.sourceUrl && <a href={r.sourceUrl} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-accent hover:underline"><ExternalLink aria-hidden className="size-3" />{t("corpus.rule2.original")}</a>}
          {r.nodeId && <Link href={`/node/${r.nodeId}`} className="text-muted hover:text-fg hover:underline">{t("corpus.approve.inGraph")}</Link>}
        </p>
      ) : r.sourceHidden ? <p className="mt-1.5 text-xs text-muted">{t("corpus.rules.hiddenSource")}</p> : null}
      {r.refs.some((x) => !x.external && x.unitKey) && (
        <p className="mt-1.5 text-xs text-muted">
          {t("corpus.rule2.refersTo")}:{" "}
          {r.refs.filter((x) => !x.external && x.unitKey).slice(0, 8).map((x, i) => {
            const to = byUnit?.get(x.unitKey!);
            return <span key={i}>{i ? ", " : ""}{to?.nodeId ? <Link href={`/node/${to.nodeId}`} className="text-accent hover:underline">{x.unitKey}</Link> : x.unitKey}</span>;
          })}
          {r.refs.some((x) => x.external) ? `; ${r.refs.filter((x) => x.external).slice(0, 3).map((x) => x.ref).join("; ")}` : ""}
        </p>
      )}
      {r.interpretation.length > 0 && (
        <details className="mt-1.5 text-xs">
          <summary className="cursor-pointer text-muted">{t("corpus.rule2.interpretation")} ({r.interpretation.length})</summary>
          <ul className="mt-1 space-y-1.5">
            {r.interpretation.map((x, i) => (
              <li key={i} className="border-l-2 border-line pl-2">
                <span className="font-read italic text-muted">“{x.quote.slice(0, 300)}{x.quote.length > 300 ? "…" : ""}”</span>{" "}
                <Link href={`/library/${x.sourceId}#chunk-${x.chunkId}`} className="text-accent hover:underline">{x.title ?? t("corpus.rule2.passage")}</Link>
              </li>
            ))}
          </ul>
        </details>
      )}
      {r.checkHint && <p className="mt-2 text-sm text-muted"><span className="font-medium text-fg">{t("corpus.rules.checkHint")}:</span> {r.checkHint}</p>}
      {canManage && (
        <div className="mt-3 flex flex-wrap gap-2">
          {proposed && onDecide && <Button size="sm" disabled={busy} onClick={() => onDecide("approve")}>{t("corpus.rules.approve")}</Button>}
          {r.change !== "removed" && <Button size="sm" variant={proposed ? "secondary" : "ghost"} disabled={busy} onClick={() => setEditing(true)}>{t("corpus.rules.edit")}</Button>}
          {proposed && onDecide && <Button size="sm" variant="ghost" disabled={busy} onClick={() => onDecide("drop")}>{t("corpus.rules.drop")}</Button>}
          {!proposed && onRetire && <Button size="sm" variant="ghost" disabled={busy} onClick={() => onRetire(!retired)}>{retired ? t("corpus.rules.restore") : t("corpus.rules.retire")}</Button>}
        </div>
      )}
    </article>
  );
}
