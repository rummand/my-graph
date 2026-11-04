import type { Metadata } from "next";
import Link from "next/link";
import { EmptyState } from "@/components/ui";
import { SearchForm } from "@/components/admin/search-form";
import { formatBytes } from "@/components/admin/format";
import { requirePlatformAdmin } from "@/lib/plans/admin";
import { listHouseholds } from "@/lib/plans/admin-data";
import { getAdminT } from "@/lib/plans/i18n";
import { getFormatDate, getLocale } from "@/lib/i18n";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getAdminT())("admin.nav.households") };
}
export const dynamic = "force-dynamic";

export default async function AdminHouseholdsPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  await requirePlatformAdmin();
  const q = (await searchParams).q?.slice(0, 200);
  const [rows, t, fmt, locale] = await Promise.all([listHouseholds({ q }), getAdminT(), getFormatDate(), getLocale()]);
  const th = "px-3 py-2 text-left text-sm font-medium text-muted";
  const num = "px-3 py-2.5 text-right text-sm tabular-nums";
  return (
    <>
      <SearchForm action="/admin/households" q={q} label={t("admin.search.label")} placeholder={t("admin.search.households")}
        submit={t("admin.search.submit")} clear={t("admin.search.clear")} />
      {rows.length === 0 ? <EmptyState title={t("admin.households.empty")} /> : (
        <div className="overflow-x-auto rounded-lg bg-surface">
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-line">
                <th className={th}>{t("admin.households.cols.name")}</th>
                <th className={`${th} hidden md:table-cell`}>{t("admin.households.cols.owner")}</th>
                <th className={th}>{t("admin.households.cols.plan")}</th>
                <th className={`${th} text-right`}>{t("admin.households.cols.members")}</th>
                <th className={`${th} hidden lg:table-cell text-right`}>{t("admin.households.cols.graphs")}</th>
                <th className={`${th} hidden lg:table-cell text-right`}>{t("admin.households.cols.sources")}</th>
                <th className={`${th} hidden sm:table-cell text-right`}>{t("admin.households.cols.storage")}</th>
                <th className={`${th} hidden xl:table-cell`}>{t("admin.households.cols.created")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((h) => (
                <tr key={h.id}>
                  <td className="px-3 py-2.5 font-medium">{h.name}</td>
                  <td className="hidden px-3 py-2.5 text-sm md:table-cell">
                    {h.ownerId ? <Link href={`/admin/accounts/${h.ownerId}`} className="text-accent hover:underline">{h.ownerName}</Link>
                      : <span className="text-muted">{t("admin.households.noOwner")}</span>}
                  </td>
                  <td className="px-3 py-2.5 text-sm">{t(`admin.plans.${h.planKey}`, undefined, h.planKey)}</td>
                  <td className={num}>{h.members}</td>
                  <td className={`${num} hidden lg:table-cell`}>{h.graphs}</td>
                  <td className={`${num} hidden lg:table-cell`}>{h.sources}</td>
                  <td className={`${num} hidden sm:table-cell text-muted`}>{formatBytes(h.bytes, locale)}</td>
                  <td className="hidden px-3 py-2.5 text-sm tabular-nums text-muted xl:table-cell">{fmt(h.createdAt, "date")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
