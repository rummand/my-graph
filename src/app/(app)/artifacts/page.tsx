import type { Metadata } from "next";
import Link from "next/link";
import { FileText, Palette, Plus, Presentation, ScrollText, UserRound, Newspaper } from "lucide-react";
import { buttonClass, Badge, EmptyState, PageHeader, Section } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { canMakeArtifacts, listArtifacts, type ArtifactSummary } from "@/lib/artifacts";
import { formatAgo, getPrefs, getT, type TFn } from "@/lib/i18n";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("artifacts.metaTitle") };
}

const KIND_ICON = { report: FileText, one_pager: Newspaper, deck: Presentation, brief: ScrollText, profile: UserRound } as const;

function Row({ a, t, ago }: { a: ArtifactSummary; t: TFn; ago: (d: string) => string }) {
  const Icon = KIND_ICON[a.kind] ?? FileText;
  return (
    <li>
      <Link href={`/artifacts/${a.id}`} className="group flex items-start gap-3 rounded-md px-2 py-3 hover:bg-surface-2/70">
        <Icon className="mt-0.5 size-[18px] shrink-0 text-muted" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-medium group-hover:underline">{a.title}</span>
            {a.drafting && <Badge tone="accent">{t("artifacts.drafting")}</Badge>}
          </span>
          <span className="mt-0.5 block text-sm text-muted">
            {t(`artifacts.kinds.${a.kind}`)}, {a.designSetName}. {t("artifacts.updated", { when: ago(a.updatedAt) })}
            {!a.isMine && a.ownerName ? ` ${t("artifacts.by", { name: a.ownerName })}` : ""}
          </span>
        </span>
        {a.status === "published" ? <Badge tone="neutral">{t("artifacts.status.published")}</Badge> : null}
      </Link>
    </li>
  );
}

export default async function ArtifactsPage() {
  const v = await requireUser();
  const [t, prefs, list] = await Promise.all([getT(), getPrefs(), listArtifacts(v)]);
  const ago = (d: string) => formatAgo(d, prefs.locale);
  const drafts = list.filter((a) => a.isMine && a.status === "draft");
  const published = list.filter((a) => a.status === "published");
  const canMake = canMakeArtifacts(v);
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title={t("artifacts.title")}
        lead={t("artifacts.lead", { graph: v.graphName })}
        actions={<>
          <Link href="/artifacts/design-sets" className={buttonClass("secondary")}><Palette className="size-4" aria-hidden />{t("artifacts.designSets")}</Link>
          {canMake && <Link href="/artifacts/new" className={buttonClass("primary")}><Plus className="size-4" aria-hidden />{t("artifacts.new")}</Link>}
        </>}
      />
      {!list.length ? (
        <EmptyState title={t("artifacts.empty.title")} icon={<FileText className="size-6" />}
          action={canMake ? <Link href="/artifacts/new" className={buttonClass("primary")}>{t("artifacts.empty.action")}</Link> : undefined}>
          {t("artifacts.empty.body")}
        </EmptyState>
      ) : (
        <div className="grid gap-10">
          {drafts.length > 0 && (
            <Section title={t("artifacts.mine")}><ul className="-mx-2">{drafts.map((a) => <Row key={a.id} a={a} t={t} ago={ago} />)}</ul></Section>
          )}
          {published.length > 0 && (
            <Section title={t("artifacts.published")}><ul className="-mx-2">{published.map((a) => <Row key={a.id} a={a} t={t} ago={ago} />)}</ul></Section>
          )}
        </div>
      )}
    </div>
  );
}
