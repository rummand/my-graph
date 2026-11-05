import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { macStatus } from "@/lib/connectors/mac/server";
import { scopeOf } from "@/lib/graphs/pure";
import { getT } from "@/lib/i18n";
import { Badge, PageHeader } from "@/components/ui";
import { MacConnect } from "@/components/connections/mac/mac-connect";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("mac.metaTitle") };
}

/**
 * My Graph for Mac: pair the helper (a one-time code), set it up (Full Disk Access for Terminal), and choose what it
 * may send: Messages conversations and/or Notes folders. Nothing is sent until the person chooses. One Mac connection
 * per person per graph.
 */
export default async function MacPage() {
  const v = await requireUser();
  const t = await getT();
  const canWrite = v.role !== "guest" && scopeOf(v).canWrite;
  const status = canWrite ? await macStatus(v) : null;
  return (
    <div className="mx-auto max-w-3xl">
      <Link href="/connections" className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg">
        <ArrowLeft className="size-4" aria-hidden />{t("mac.back")}
      </Link>
      <PageHeader title={t("mac.title")} lead={t("mac.lead")} />
      <div className="-mt-2 mb-8 max-w-[65ch]">
        <Badge tone="warn">{t("mac.unofficial")}</Badge>
        <p className="mt-2 text-sm text-muted">{t("mac.unofficialWhy")}</p>
      </div>
      {status ? <MacConnect initial={status} /> : <p className="max-w-[65ch] text-muted">{t("mac.readOnly")}</p>}
    </div>
  );
}
