import Link from "next/link";
import type { ChangeSetView } from "@/lib/changes";
import type { Locale, TFn } from "@/lib/i18n/core";
import { formatDate } from "@/lib/i18n/dates";
import { ChangeSetActions, ReceiptLine } from "@/components/changes";
import { readProps } from "@/lib/commitments/pure";
import { KIND_ICON } from "./words";

/**
 * "Waiting for you": proposals of new commitments, each as a compact card (what has to happen, when, the passage it
 * comes from) with Deliver / Review / Drop from the change-set components. Nothing is on the list until delivered.
 */
export function WaitingCommitments({ sets, total, t, locale, tz, canDeliver }: { sets: ChangeSetView[]; total: number; t: TFn; locale: Locale; tz: string; canDeliver: boolean }) {
  if (!sets.length) return null;
  return (
    <section aria-labelledby="waiting-h" className="min-w-0">
      <div className="mb-2.5">
        <h2 id="waiting-h" className="text-lg font-semibold tracking-[-0.01em]">
          {t("commitments.waiting.title")}
          <span className="ml-2 rounded-full bg-warn-tint px-2 py-0.5 align-middle text-xs font-medium tabular-nums text-warn">{total}</span>
        </h2>
        <p className="mt-0.5 text-sm text-muted">{t("commitments.waiting.hint")}</p>
      </div>
      <ul className="space-y-2">
        {sets.slice(0, 1).map((cs) => {
          const adds = cs.changes.filter((c) => c.op === "addNode" && c.included && (c.payload as { type?: unknown }).type === "commitment");
          return (
            <li key={cs.id} className="rounded-lg bg-surface p-4">
              <Link href={`/changes/${cs.id}`} className="block text-sm text-muted hover:text-fg hover:underline">{cs.title}</Link>
              <ul className="mt-2 space-y-2">
                {adds.slice(0, 3).map((c) => {
                  const p = c.payload as { label?: string; startAt?: string | null; props?: Record<string, unknown>; kind?: string };
                  const props = readProps(p.props, { startAt: p.startAt ?? null, kind: p.kind ?? null });
                  const Icon = KIND_ICON[props.kind];
                  return (
                    <li key={c.id} className="flex items-start gap-2.5">
                      <Icon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted" />
                      <div className="min-w-0">
                        <p className="break-words font-medium">{p.label}</p>
                        <p className="text-sm text-muted">
                          {props.dueAt ? formatDate(props.dueAt, "weekday", { locale, timeZone: tz }) : t("commitments.due.none")}
                        </p>
                        <ReceiptLine r={c.receipt ?? {}} t={t} />
                      </div>
                    </li>
                  );
                })}
              </ul>
              <ChangeSetActions id={cs.id} fingerprint={cs.fingerprint ?? null} canDeliver={canDeliver}
                hasConflicts={cs.summary ? !cs.summary.deliverable : Object.values(cs.verdicts).some((x) => x === "conflicted")}
                nothingNew={!!cs.summary?.nothingNew} partial={(cs.summary?.leftOut ?? 0) > 0} count={cs.summary?.included ?? cs.changes.length} />
            </li>
          );
        })}
      </ul>
      {sets.length > 1 && (
        <ul className="mt-2 space-y-1">
          {sets.slice(1).map((cs) => {
            const n = cs.changes.filter((c) => c.op === "addNode" && c.included && (c.payload as { type?: unknown }).type === "commitment");
            const first = n[0]?.payload as { label?: string } | undefined;
            return (
              <li key={cs.id}>
                <Link href={`/changes/${cs.id}`} className="block rounded-lg bg-surface px-4 py-2.5 hover:bg-surface-2">
                  <span className="block break-words text-[15px]">{first?.label ?? cs.title}{n.length > 1 ? ` +${n.length - 1}` : ""}</span>
                  <span className="block truncate text-xs text-muted">{cs.title}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      {total > sets.length && (
        <p className="mt-2 text-sm"><Link href="/changes" className="text-accent hover:underline">{t("commitments.waiting.more", { count: total - sets.length })}</Link></p>
      )}
    </section>
  );
}
