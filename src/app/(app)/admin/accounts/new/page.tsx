import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { NewAccountForm, type NewAccountCopy } from "@/components/admin/new-account-form";
import { requirePlatformAdmin } from "@/lib/plans/admin";
import { visiblePlans } from "@/lib/plans/catalog";
import { getAdminT } from "@/lib/plans/i18n";
import { listPlans } from "@/lib/plans/store";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getAdminT())("admin.newAccount.title") };
}
export const dynamic = "force-dynamic";

const KEYS = [
  "title", "lead", "name", "email", "household", "householdHint", "householdPlaceholder", "graph", "graphFamily", "graphFamilyHint",
  "graphPersonal", "graphPersonalHint", "plan", "access", "accessLink", "accessLinkHint", "accessTemp", "accessTempHint", "create",
  "creating", "doneTitle", "doneLink", "donePassword", "copy", "copied", "openAccount", "another", "failed",
] as const;

/** Add an account: a household of their own, a first graph, a plan, and a link or temporary password to hand over. */
export default async function NewAccountPage() {
  await requirePlatformAdmin();
  const [t, allPlans] = await Promise.all([getAdminT(), listPlans()]);
  // Placeholders the form fills in itself are passed through as {name} / {date} / {example}.
  const copy = Object.fromEntries(KEYS.map((k) => [k, t(`admin.newAccount.${k}`, { name: "{name}", date: "{date}", example: "{example}" })])) as NewAccountCopy;
  const plans = visiblePlans(allPlans, { isAdmin: true }).map((p) => ({ key: p.key, name: t(`admin.plans.${p.key}`, undefined, p.key) }));

  return (
    <>
      <Link href="/admin" className="mb-5 inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg">
        <ArrowLeft size={16} aria-hidden />{t("admin.newAccount.back")}
      </Link>
      <NewAccountForm plans={plans} defaultPlan={plans.find((p) => p.key === "free")?.key ?? plans[0]?.key ?? ""} copy={copy} />
    </>
  );
}
