import type { Metadata } from "next";
import Link from "next/link";
import { clsx } from "clsx";
import { requireUser } from "@/lib/auth";
import { listChangeSets } from "@/lib/changes";
import { scopeOf } from "@/lib/graphs/pure";
import { getLocale, getT } from "@/lib/i18n";
import { EmptyState, PageHeader } from "@/components/ui";
import { ChangeSetCard } from "@/components/changes";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  return { title: `${(await getT())("changes.title")} · My Graph` };
}

const FILTERS = ["draft", "delivered", "abandoned", "all"] as const;
type Filter = (typeof FILTERS)[number];

export default async function ChangesPage({ searchParams }: { searchParams: Promise<{ status?: string | string[] }> }) {
  const v = await requireUser();
  const raw = (await searchParams).status;
  const status: Filter = typeof raw === "string" && (FILTERS as readonly string[]).includes(raw) ? (raw as Filter) : "draft";
  const [sets, t, locale] = await Promise.all([listChangeSets(v, { status, limit: 50 }).catch(() => []), getT(), getLocale()]);
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title={t("changes.title")} lead={scopeOf(v).family ? t("changes.leadFamily") : t("changes.lead", { graph: v.graphName })} />
      <nav aria-label={t("changes.title")} className="mb-6 flex flex-wrap gap-1">
        {FILTERS.map((f) => (
          <Link key={f} href={f === "draft" ? "/changes" : `/changes?status=${f}`} aria-current={f === status ? "page" : undefined}
            className={clsx("inline-flex h-8 items-center rounded-full px-3 text-sm transition-colors", f === status ? "bg-surface font-medium text-fg" : "text-muted hover:bg-surface-2")}>
            {t(`changes.filter.${f}`)}
          </Link>
        ))}
      </nav>
      {sets.length === 0 ? (
        <EmptyState title={t("changes.empty")}>{status === "draft" ? t("changes.emptyDraft") : null}</EmptyState>
      ) : (
        <div className="space-y-4">
          {sets.map((cs) => <ChangeSetCard key={cs.id} cs={cs} t={t} locale={locale} compact />)}
        </div>
      )}
    </div>
  );
}
