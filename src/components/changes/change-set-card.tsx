import Link from "next/link";
import { clsx } from "clsx";
import { FileText, Globe, MessageSquare } from "lucide-react";
import type { ChangeSetView, Receipt } from "@/lib/changes";
import type { Locale, TFn } from "@/lib/i18n/core";
import { Badge } from "@/components/ui";
import { formatDate } from "@/components/provenance/labels";

const OPS = ["addNode", "updateNode", "retireNode", "mergeNodes", "addEdge", "updateEdge", "removeEdge", "addKind", "addRelationType", "addAttribute", "addReminder", "editWiki"];
const ORIGINS = ["person", "assistant", "chat", "connector", "web", "ingest", "automation", "heartbeat", "keeper", "restore"];

export function originLabel(origin: string, t: TFn): string {
  return ORIGINS.includes(origin) ? t(`changes.origin.${origin}`) : origin;
}
function opLabel(op: string, t: TFn): string {
  return OPS.includes(op) ? t(`changes.op.${op}`) : op;
}

/** Where one change came from, as a link a person can follow. */
function ReceiptLine({ r, t }: { r: Receipt; t: TFn }) {
  const sure = typeof r.confidence === "number" ? t("changes.receipt.sure", { pct: Math.round(r.confidence * 100) }) : null;
  let link: React.ReactNode = null;
  if (r.sourceId) {
    link = <Link className="inline-flex items-center gap-1 text-accent hover:underline" href={`/library/${r.sourceId}`}><FileText aria-hidden className="size-3.5" />{t("changes.receipt.sourceUntitled")}</Link>;
  } else if (r.conversationId) {
    link = <Link className="inline-flex items-center gap-1 text-accent hover:underline" href={`/chat/${r.conversationId}`}><MessageSquare aria-hidden className="size-3.5" />{t("changes.receipt.conversation")}</Link>;
  } else if (r.url && /^https?:\/\//.test(r.url)) {
    link = <a className="inline-flex items-center gap-1 text-accent hover:underline" href={r.url} rel="noreferrer noopener" target="_blank"><Globe aria-hidden className="size-3.5" />{t("changes.receipt.web")}</a>;
  }
  if (!link && !r.quote && !sure) return null;
  return (
    <div className="mt-1.5 text-sm">
      {r.quote && <blockquote className="break-words border-l border-line pl-3 text-fg/90">&ldquo;{r.quote}&rdquo;</blockquote>}
      <p className="mt-1 flex flex-wrap items-center gap-x-3 text-xs text-muted">{link}{sure && <span className="tabular-nums">{sure}</span>}</p>
    </div>
  );
}

/**
 * One proposal with every change and its receipt. Read-only and server-safe: deciding (deliver / turn down) belongs
 * to the versioning workstream's routes and is wired here once they exist.
 */
export function ChangeSetCard({ cs, t, locale, compact = false }: { cs: ChangeSetView; t: TFn; locale: Locale; compact?: boolean }) {
  const shown = compact ? cs.changes.slice(0, 4) : cs.changes;
  return (
    <article className="rounded-lg bg-surface p-5">
      <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
        <div className="min-w-0">
          <h2 className="break-words text-lg/6 font-semibold tracking-[-0.01em]">
            {compact ? <Link href={`/changes/${cs.id}`} className="hover:underline">{cs.title}</Link> : cs.title}
          </h2>
          <p className="mt-0.5 text-sm text-muted">
            {originLabel(cs.origin, t)}{cs.createdByName ? ` ${t("changes.by", { name: cs.createdByName })}` : ""}
            {", "}{cs.deliveredAt ? t("changes.deliveredAt", { date: formatDate(cs.deliveredAt, locale) }) : t("changes.created", { date: formatDate(cs.createdAt, locale) })}
          </p>
        </div>
        <Badge tone={cs.status === "draft" ? "warn" : cs.status === "delivered" ? "accent" : "neutral"}>{t(`changes.status.${cs.status}`)}</Badge>
      </header>
      {cs.description && <p className="mt-3 max-w-[65ch] text-[15px]">{cs.description}</p>}
      <ul className="mt-4 divide-y divide-line/70">
        {shown.map((c) => {
          const verdict = cs.verdicts[c.id];
          return (
            <li key={c.id} className={clsx("py-3 first:pt-0", !c.included && "opacity-60")}>
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="text-sm text-muted">{opLabel(c.op, t)}</span>
                <span className="min-w-0 break-words">
                  {c.nodeId ? <Link href={`/node/${c.nodeId}`} className="hover:underline">{c.summary}</Link> : c.summary}
                </span>
                {!c.included && <Badge>{t("changes.excluded")}</Badge>}
                {verdict === "conflicted" && <Badge tone="danger">{t("changes.verdict.conflicted")}</Badge>}
                {verdict === "landed" && cs.status === "draft" && <Badge tone="accent">{t("changes.verdict.landed")}</Badge>}
              </div>
              {c.note && <p className="mt-1 text-sm text-fg/85">{c.note}</p>}
              {!compact && <ReceiptLine r={c.receipt ?? {}} t={t} />}
            </li>
          );
        })}
      </ul>
      {compact && cs.changes.length > shown.length && (
        <p className="mt-2 text-sm"><Link href={`/changes/${cs.id}`} className="text-accent hover:underline">{t("changes.count", { count: cs.changes.length })}</Link></p>
      )}
    </article>
  );
}
