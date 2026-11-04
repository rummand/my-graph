import type { Metadata } from "next";
import { Suspense } from "react";
import { EmptyState, PageHeader } from "@/components/ui";
import { AutomationsApp } from "@/components/automations/automations-app";
import { requireUser } from "@/lib/auth";
import { loadAutomationsPage } from "@/lib/automations/overview";
import { canUseAssistantTools } from "@/lib/automations/policy";

export const metadata: Metadata = { title: "Automations" };
export const dynamic = "force-dynamic";

export default async function AutomationsPage() {
  const v = await requireUser();
  if (!canUseAssistantTools(v)) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Automations" />
        <EmptyState title="This part is for parents">The assistant&apos;s check-ins, automations and recipes are set up by the parents in your family.</EmptyState>
      </div>
    );
  }
  const data = await loadAutomationsPage(v);
  return (
    <Suspense>
      <AutomationsApp data={data} />
    </Suspense>
  );
}
