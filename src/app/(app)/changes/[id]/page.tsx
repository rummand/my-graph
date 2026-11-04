import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { getChangeSet } from "@/lib/changes";
import { reviewContext } from "@/lib/changes/store";
import { isUuid } from "@/lib/gbrain";
import { getLocale, getT } from "@/lib/i18n";
import { Badge, EmptyState } from "@/components/ui";
import { ChangeSetReview, originLabel } from "@/components/changes";
import { formatDate } from "@/components/provenance/labels";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const t = await getT();
  const { id } = await params;
  const v = await requireUser();
  const cs = isUuid(id) ? await getChangeSet(v, id).catch(() => null) : null;
  return { title: `${cs?.title ?? t("changes.title")} · My Graph` };
}

export default async function ChangeSetPage({ params }: Props) {
  const { id } = await params;
  const v = await requireUser();
  const [cs, t, locale] = await Promise.all([isUuid(id) ? getChangeSet(v, id).catch(() => null) : Promise.resolve(null), getT(), getLocale()]);
  const context = cs ? await reviewContext(v, cs) : null;
  return (
    <div className="mx-auto max-w-3xl">
      <Link href="/changes" className="mb-6 inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg">
        <ArrowLeft className="size-4" aria-hidden /> {t("changes.back")}
      </Link>
      {cs && context ? (
        <>
          <header className="mb-6">
            <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
              <h1 className="min-w-0 break-words text-[28px]/[1.15] font-semibold tracking-[-0.02em]">{cs.title}</h1>
              <Badge tone={cs.status === "draft" ? "warn" : cs.status === "delivered" ? "accent" : "neutral"}>{t(`changes.status.${cs.status}`)}</Badge>
            </div>
            <p className="mt-1.5 text-sm text-muted">
              {originLabel(cs.origin, t)}{cs.createdByName ? ` ${t("changes.by", { name: cs.createdByName })}` : ""}
              {", "}{cs.deliveredAt ? t("changes.deliveredAt", { date: formatDate(cs.deliveredAt, locale) }) : t("changes.created", { date: formatDate(cs.createdAt, locale) })}
              {", "}{t("changes.count", { count: cs.changes.length })}
            </p>
            {cs.description && <p className="mt-3 max-w-[65ch] break-words">{cs.description}</p>}
            {cs.status === "draft" && <p className="mt-3 text-sm text-muted">{t("changes.decideHint")}</p>}
          </header>
          <ChangeSetReview initial={cs} context={context} />
        </>
      ) : (
        <EmptyState title={t("changes.notFound")}>{t("changes.notFoundBody")}</EmptyState>
      )}
    </div>
  );
}
