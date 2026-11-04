import type { Metadata } from "next";
import { PageHeader } from "@/components/ui";
import { AdminNav } from "@/components/admin/admin-nav";
import { requirePlatformAdmin } from "@/lib/plans/admin";
import { adminTotals } from "@/lib/plans/admin-data";
import { getAdminT } from "@/lib/plans/i18n";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { robots: { index: false, follow: false } };

/** The platform admin console. Every page under it checks again (layouts alone don't guard a route). */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  await requirePlatformAdmin();
  const [t, totals] = await Promise.all([getAdminT(), adminTotals()]);
  const lead = [
    t("admin.totals.accounts", { count: totals.accounts }),
    t("admin.totals.households", { count: totals.households }),
    t("admin.totals.graphs", { count: totals.graphs }),
  ].join(", ");
  return (
    <>
      <PageHeader title={t("admin.title")} lead={<>{t("admin.lead")}<span className="mt-1 block text-sm">{lead}.</span></>} />
      <AdminNav label={t("admin.nav.label")} items={[
        { href: "/admin", label: t("admin.nav.accounts") },
        { href: "/admin/households", label: t("admin.nav.households") },
        { href: "/admin/graphs", label: t("admin.nav.graphs") },
        { href: "/admin/audit", label: t("admin.nav.audit") },
      ]} />
      {children}
    </>
  );
}
