import type { Metadata } from "next";
import { EmptyState } from "@/components/ui";
import { AuditList } from "@/components/admin/audit-list";
import { requirePlatformAdmin } from "@/lib/plans/admin";
import { adminAudit } from "@/lib/plans/admin-data";
import { getAdminT } from "@/lib/plans/i18n";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getAdminT())("admin.nav.audit") };
}
export const dynamic = "force-dynamic";

/** Every admin action, with the admin who took it. */
export default async function AdminAuditPage() {
  await requirePlatformAdmin();
  const [rows, t] = await Promise.all([adminAudit({ limit: 300 }), getAdminT()]);
  return (
    <>
      <p className="mb-5 max-w-[60ch] text-sm text-muted">{t("admin.audit.lead")}</p>
      {rows.length === 0 ? <EmptyState title={t("admin.audit.empty")} /> : <AuditList rows={rows} />}
    </>
  );
}
