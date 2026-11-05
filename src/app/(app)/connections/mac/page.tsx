import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, Download } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { macStatus } from "@/lib/connectors/mac/server";
import { scopeOf } from "@/lib/graphs/pure";
import { getT } from "@/lib/i18n";
import { Badge, PageHeader, Section, buttonClass } from "@/components/ui";
import { MacConnect } from "@/components/connections/mac/mac-connect";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("mac.metaTitle") };
}

/**
 * My Graph for Mac: the menu bar app is recommended (it signs in with the person's account and is set up in the app);
 * the Node helper stays as the alternative: pair it (a one-time code), set it up (Full Disk Access for Terminal), and
 * choose what it may send: Messages conversations and/or Notes folders. Nothing is sent until the person chooses. One
 * Mac connection per person per graph (app and helper share it; signing in with one replaces the other's key).
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
      <Section title={t("mac.app.title")} className="mb-10">
        <div className="max-w-[65ch] space-y-3 text-sm">
          <p>{t("mac.app.lead")}</p>
          {status?.helper?.kind === "app" ? (
            <p className="text-accent">
              {status.helper.device
                ? t("mac.app.signedIn", { device: status.helper.device, version: status.helper.appVersion ?? "?" })
                : t("mac.app.signedInNoName", { version: status.helper.appVersion ?? "?" })}
            </p>
          ) : null}
          <p className="text-muted">{t("mac.app.sources")}</p>
          <p className="text-muted">{t("mac.app.writeBack")}</p>
          <p className="text-muted">{t("mac.app.off")}</p>
          <div className="flex flex-wrap items-center gap-3 pt-1">
            <a href="/downloads/MyGraph-mac.zip" className={buttonClass("primary")} download>
              <Download className="size-4" aria-hidden />{t("mac.app.download")}
            </a>
            <span className="text-xs text-muted">{t("mac.app.soon")}</span>
          </div>
        </div>
      </Section>
      <h2 className="mb-1 text-lg font-semibold">{t("mac.app.alternative")}</h2>
      <p className="mb-6 max-w-[65ch] text-sm text-muted">{t("mac.app.alternativeLead")}</p>
      {status ? <MacConnect initial={status} /> : <p className="max-w-[65ch] text-muted">{t("mac.readOnly")}</p>}
    </div>
  );
}
