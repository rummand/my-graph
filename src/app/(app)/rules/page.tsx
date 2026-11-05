import type { Metadata } from "next";
import Link from "next/link";
import { clsx } from "clsx";
import { Scale } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { canManageCorpora, listCorpora, type CorpusSummary } from "@/lib/corpus";
import { getFormatDate, getT, type TFn } from "@/lib/i18n";
import { Badge, EmptyState, PageHeader } from "@/components/ui";
import { NewCorpus } from "@/components/corpus/new-corpus";
import { AddFromLink } from "@/components/corpus/add-from-link";
import { ruleSetKind } from "@/lib/corpus/pure";
import { CorporaDefaults } from "@/components/corpus/defaults";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  return { title: `${(await getT())("corpus.title")} · My Graph` };
}

function coverageLine(t: TFn, c: CorpusSummary, fmt: (d: string, s?: "date") => string): string {
  const parts = [t("corpus.coverage.rules", { count: c.counts.active })];
  if (c.counts.proposed) parts.push(t("corpus.coverage.proposed", { count: c.counts.proposed }));
  if (c.work && (c.work.status === "running" || c.work.status === "queued")) { parts.push(t("corpus.work.running").split(".")[0]); return parts.join(", "); }
  const last = c.readState?.finishedAt ?? null;
  parts.push(last ? t("corpus.coverage.lastRead", { date: fmt(last, "date") }) : t("corpus.coverage.neverRead"));
  return parts.join(", ");
}

export default async function RulesPage({ searchParams }: { searchParams: Promise<{ url?: string }> }) {
  const v = await requireUser();
  const { url } = await searchParams;
  const [list, t, fmt] = await Promise.all([listCorpora(v).catch(() => []), getT(), getFormatDate()]);
  const manage = canManageCorpora(v);
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title={t("corpus.title")} lead={t("corpus.lead", { graph: v.graphName })} />
      {manage && <div className="mb-8"><AddFromLink initial={typeof url === "string" ? url.slice(0, 2000) : ""} /></div>}
      {list.length === 0 ? (
        <EmptyState icon={<Scale className="size-6" aria-hidden />} title={t("corpus.title")} action={manage ? <NewCorpus label={t("corpus.emptyAction")} /> : undefined}>
          {t("corpus.empty")}
        </EmptyState>
      ) : (
        <ul className="divide-y divide-line">
          {list.map((c) => (
            <li key={c.id}>
              <Link href={`/rules/${c.id}`} className="-mx-3 flex items-start gap-3 rounded-md px-3 py-4 transition-colors hover:bg-surface-2/60">
                <Scale aria-hidden className={clsx("mt-1 size-4 shrink-0", c.counts.proposed ? "text-warn" : "text-muted")} />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{c.name}</span>
                    <Badge tone={c.status === "active" ? "accent" : "neutral"}>{t(`corpus.status.${c.status}`)}</Badge>
                    {c.binding === "advisory" && <Badge>{t("corpus.binding.advisory")}</Badge>}
                  </span>
                  <span className="mt-0.5 block text-sm text-muted">
                    {t(`corpus.kind.${ruleSetKind(c.kind)}`)}{c.authority ? `, ${c.authority}` : ""}{c.version ? `, ${c.version}` : ""}
                  </span>
                  <span className={clsx("mt-1 block text-sm", c.counts.proposed ? "text-warn" : "text-muted")}>{coverageLine(t, c, fmt)}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {list.length > 0 && <CorporaDefaults canManage={manage} graphName={v.graphName} />}
      {manage && list.length > 0 && <div className="mt-8 border-t border-line pt-6"><NewCorpus /></div>}
      {!manage && <p className="mt-6 text-sm text-muted">{t("corpus.notAllowed")}</p>}
    </div>
  );
}
