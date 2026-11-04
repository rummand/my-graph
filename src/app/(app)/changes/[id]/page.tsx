import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { getChangeSet } from "@/lib/changes";
import { isUuid } from "@/lib/gbrain";
import { getLocale, getT } from "@/lib/i18n";
import { EmptyState } from "@/components/ui";
import { ChangeSetCard } from "@/components/changes";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata(): Promise<Metadata> {
  return { title: `${(await getT())("changes.title")} · My Graph` };
}

export default async function ChangeSetPage({ params }: Props) {
  const { id } = await params;
  const v = await requireUser();
  const [cs, t, locale] = await Promise.all([isUuid(id) ? getChangeSet(v, id).catch(() => null) : Promise.resolve(null), getT(), getLocale()]);
  return (
    <div className="mx-auto max-w-3xl">
      <Link href="/changes" className="mb-6 inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg">
        <ArrowLeft className="size-4" aria-hidden /> {t("changes.back")}
      </Link>
      {cs ? (
        <>
          <ChangeSetCard cs={cs} t={t} locale={locale} />
          {cs.status === "draft" && <p className="mt-3 text-sm text-muted">{t("changes.decideHint")}</p>}
        </>
      ) : (
        <EmptyState title={t("changes.notFound")}>{t("changes.notFoundBody")}</EmptyState>
      )}
    </div>
  );
}
