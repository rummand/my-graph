import type { Metadata } from "next";
import Link from "next/link";
import { Badge, EmptyState } from "@/components/ui";
import { SearchForm } from "@/components/admin/search-form";
import { formatBytes } from "@/components/admin/format";
import { requirePlatformAdmin } from "@/lib/plans/admin";
import { listGraphs } from "@/lib/plans/admin-data";
import { getAdminT } from "@/lib/plans/i18n";
import { getFormatDate, getLocale } from "@/lib/i18n";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getAdminT())("admin.nav.graphs") };
}
export const dynamic = "force-dynamic";

/** Graphs: names, owners and counts. Never their content; there is no way from here into a graph. */
export default async function AdminGraphsPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  await requirePlatformAdmin();
  const q = (await searchParams).q?.slice(0, 200);
  const [rows, t, fmt, locale] = await Promise.all([listGraphs({ q }), getAdminT(), getFormatDate(), getLocale()]);
  const th = "px-3 py-2 text-left text-sm font-medium text-muted";
  const num = "px-3 py-2.5 text-right text-sm tabular-nums";
  return (
    <>
      <SearchForm action="/admin/graphs" q={q} label={t("admin.search.label")} placeholder={t("admin.search.graphs")}
        submit={t("admin.search.submit")} clear={t("admin.search.clear")} />
      {rows.length === 0 ? <EmptyState title={t("admin.graphs.empty")} /> : (
        <div className="overflow-x-auto rounded-lg bg-surface">
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-line">
                <th className={th}>{t("admin.graphs.cols.name")}</th>
                <th className={`${th} hidden md:table-cell`}>{t("admin.graphs.cols.household")}</th>
                <th className={`${th} hidden sm:table-cell`}>{t("admin.graphs.cols.owner")}</th>
                <th className={`${th} text-right`}>{t("admin.graphs.cols.members")}</th>
                <th className={`${th} hidden lg:table-cell text-right`}>{t("admin.graphs.cols.nodes")}</th>
                <th className={`${th} hidden lg:table-cell text-right`}>{t("admin.graphs.cols.sources")}</th>
                <th className={`${th} hidden sm:table-cell text-right`}>{t("admin.graphs.cols.storage")}</th>
                <th className={`${th} hidden xl:table-cell`}>{t("admin.graphs.cols.created")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((g) => (
                <tr key={g.id}>
                  <td className="px-3 py-2.5">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span className="font-medium">{g.name}</span>
                      {g.archived && <Badge>{t("admin.graphs.archived")}</Badge>}
                    </span>
                    <span className="block text-xs text-muted">{t(`admin.graphs.kinds.${g.kind}`, undefined, g.kind)}</span>
                  </td>
                  <td className="hidden px-3 py-2.5 text-sm md:table-cell">{g.householdName}</td>
                  <td className="hidden px-3 py-2.5 text-sm sm:table-cell">
                    {g.ownerId ? <Link href={`/admin/accounts/${g.ownerId}`} className="text-accent hover:underline">{g.ownerName}</Link> : "–"}
                  </td>
                  <td className={num}>{g.members}</td>
                  <td className={`${num} hidden lg:table-cell`}>{g.nodes}</td>
                  <td className={`${num} hidden lg:table-cell`}>{g.sources}</td>
                  <td className={`${num} hidden sm:table-cell text-muted`}>{formatBytes(g.bytes, locale)}</td>
                  <td className="hidden px-3 py-2.5 text-sm tabular-nums text-muted xl:table-cell">{fmt(g.createdAt, "date")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
