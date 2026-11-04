import type { Metadata } from "next";
import { Suspense } from "react";
import { EmptyState, PageHeader } from "@/components/ui";
import { AutomationsApp } from "@/components/automations/automations-app";
import { requireUser } from "@/lib/auth";
import { loadAutomationsPage } from "@/lib/automations/overview";
import { canUseAssistantTools } from "@/lib/automations/policy";
import { getT } from "@/lib/i18n";
import { variantOf } from "@/components/memory/variant";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("automations.metaTitle") };
}

export default async function AutomationsPage() {
  const v = await requireUser();
  const vr = variantOf(v.graphKind);
  if (!canUseAssistantTools(v)) {
    const t = await getT();
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title={t("automations.title")} />
        <EmptyState title={t(`automations.notAllowed.title.${vr}`)}>{t(`automations.notAllowed.body.${vr}`)}</EmptyState>
      </div>
    );
  }
  const data = await loadAutomationsPage(v);
  return (
    <Suspense>
      <AutomationsApp data={data} variant={vr} />
    </Suspense>
  );
}
