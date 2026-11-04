import Link from "next/link";
import { clsx } from "clsx";
import type { ChangeSetView } from "@/lib/changes";
import type { Locale, TFn } from "@/lib/i18n/core";
import { Badge } from "@/components/ui";
import { formatDate } from "@/components/provenance/labels";
import { ReceiptLine } from "./receipt";
import { ChangeSetActions } from "./change-set-actions";

const OPS = ["addNode", "updateNode", "retireNode", "mergeNodes", "addEdge", "updateEdge", "removeEdge", "addKind", "addRelationType", "addAttribute", "addReminder", "editWiki"];
const ORIGINS = ["person", "assistant", "chat", "connector", "web", "ingest", "automation", "heartbeat", "keeper", "restore"];

export function originLabel(origin: string, t: TFn): string {
  return ORIGINS.includes(origin) ? t(`changes.origin.${origin}`) : origin;
}
function opLabel(op: string, t: TFn): string {
  return OPS.includes(op) ? t(`changes.op.${op}`) : op;
}

/**
 * One proposal with its changes and their receipts. Server-safe. `actions` adds Deliver all / Review / Drop for a
 * proposal still waiting (Today, a library item); the full review with tick boxes is on /changes/[id].
 */
export function ChangeSetCard({ cs, t, locale, compact = false, actions = false, canDeliver = true }: { cs: ChangeSetView; t: TFn; locale: Locale; compact?: boolean; actions?: boolean; canDeliver?: boolean }) {
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
      {actions && cs.status === "draft" && (
        <ChangeSetActions id={cs.id} fingerprint={cs.fingerprint ?? null} canDeliver={canDeliver} hasConflicts={Object.values(cs.verdicts).some((x) => x === "conflicted")} />
      )}
    </article>
  );
}
