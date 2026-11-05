import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { aulaStatus } from "@/lib/connectors/dk/aula/pairing";
import { getT } from "@/lib/i18n";
import { Badge, PageHeader } from "@/components/ui";
import { AulaConnect } from "@/components/connections/aula/aula-connect";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("aula.metaTitle") };
}

/**
 * Connect Aula: the helper page. The parent gets a one-time pairing code here, runs the Connect Aula helper on a
 * computer at home (MitID in their own browser and app), and the helper hands My Graph only the tokens. Family graphs
 * only; one Aula connection per person per graph.
 */
export default async function ConnectAulaPage() {
  const v = await requireUser();
  const t = await getT();
  const family = v.graphKind === "family";
  const status = family ? await aulaStatus(v) : null;
  return (
    <div className="mx-auto max-w-3xl">
      <Link href="/connections" className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg">
        <ArrowLeft className="size-4" aria-hidden />{t("aula.back")}
      </Link>
      <PageHeader title={t("aula.title")} lead={t("aula.lead")} />
      <div className="-mt-2 mb-8 max-w-[65ch]">
        <Badge tone="warn">{t("aula.unofficial")}</Badge>
        <p className="mt-2 text-sm text-muted">{t("aula.unofficialWhy")}</p>
      </div>
      {family && status ? <AulaConnect initial={status} /> : <p className="max-w-[65ch] text-muted">{t("aula.familyOnly")}</p>}
    </div>
  );
}
