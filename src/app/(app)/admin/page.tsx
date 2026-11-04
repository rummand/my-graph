import type { Metadata } from "next";
import Link from "next/link";
import { Avatar, Badge, EmptyState } from "@/components/ui";
import { SearchForm } from "@/components/admin/search-form";
import { formatBytes } from "@/components/admin/format";
import { requirePlatformAdmin } from "@/lib/plans/admin";
import { listAccounts } from "@/lib/plans/admin-data";
import { getAdminT } from "@/lib/plans/i18n";
import { formatAgo, getFormatDate, getLocale } from "@/lib/i18n";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getAdminT())("admin.nav.accounts") };
}
export const dynamic = "force-dynamic";

/** Accounts: metadata only (who, where, plan, activity, counts and storage). */
export default async function AdminAccountsPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const v = await requirePlatformAdmin();
  const q = (await searchParams).q?.slice(0, 200);
  const [rows, t, fmt, locale] = await Promise.all([listAccounts({ q }), getAdminT(), getFormatDate(), getLocale()]);
  const plan = (k: string) => t(`admin.plans.${k}`, undefined, k);
  const th = "px-3 py-2 text-left text-sm font-medium text-muted";
  const num = "px-3 py-2.5 text-right text-sm tabular-nums";

  return (
    <>
      <SearchForm action="/admin" q={q} label={t("admin.search.label")} placeholder={t("admin.search.accounts")}
        submit={t("admin.search.submit")} clear={t("admin.search.clear")} />
      {rows.length === 0 ? (
        <EmptyState title={q ? t("admin.accounts.emptySearch", { q }) : t("admin.accounts.empty")} />
      ) : (
        <div className="overflow-x-auto rounded-lg bg-surface">
          <table className="w-full min-w-0 border-collapse">
            <thead>
              <tr className="border-b border-line">
                <th className={th}>{t("admin.accounts.cols.person")}</th>
                <th className={`${th} hidden md:table-cell`}>{t("admin.accounts.cols.household")}</th>
                <th className={th}>{t("admin.accounts.cols.plan")}</th>
                <th className={`${th} hidden lg:table-cell`}>{t("admin.accounts.cols.created")}</th>
                <th className={`${th} hidden lg:table-cell`}>{t("admin.accounts.cols.lastActive")}</th>
                <th className={`${th} hidden xl:table-cell text-right`}>{t("admin.accounts.cols.graphs")}</th>
                <th className={`${th} hidden xl:table-cell text-right`}>{t("admin.accounts.cols.sources")}</th>
                <th className={`${th} hidden sm:table-cell text-right`}>{t("admin.accounts.cols.storage")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((a) => (
                <tr key={a.id} className="hover:bg-surface-2/60">
                  <td className="px-3 py-2.5">
                    <Link href={`/admin/accounts/${a.id}`} className="flex min-w-0 items-center gap-2.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent rounded-md">
                      <Avatar id={a.id} name={a.name} size={28} />
                      <span className="min-w-0">
                        <span className="flex flex-wrap items-center gap-1.5">
                          <span className="max-w-[9.5rem] truncate font-medium sm:max-w-none">{a.name}</span>
                          {a.id === v.id && <Badge>{t("admin.accounts.you")}</Badge>}
                          {a.locked && <Badge tone="danger">{t("admin.accounts.locked")}</Badge>}
                        </span>
                        <span className="block max-w-[11rem] truncate text-sm text-muted sm:max-w-none">{a.email}</span>
                      </span>
                    </Link>
                  </td>
                  <td className="hidden px-3 py-2.5 text-sm md:table-cell">
                    {a.householdName}
                    <span className="block text-xs text-muted">{t(`admin.roles.${a.role}`)}{a.isPlatformAdmin ? `, ${t("admin.accounts.admin").toLowerCase()}` : ""}</span>
                  </td>
                  <td className="px-3 py-2.5 text-sm">
                    <span className="font-medium">{plan(a.planKey)}</span>
                    {a.planInherited && <span className="block text-xs text-muted">{t("admin.accounts.inherited")}</span>}
                    {a.planKey === "ultimate" && a.addons.length > 0 && (
                      <span className="mt-1 hidden flex-wrap gap-1 sm:flex">
                        {a.addons.map((x) => <Badge key={x} tone="accent">{t(`admin.addons.${x}`)}</Badge>)}
                      </span>
                    )}
                  </td>
                  <td className="hidden px-3 py-2.5 text-sm tabular-nums text-muted lg:table-cell">{fmt(a.createdAt, "date")}</td>
                  <td className="hidden px-3 py-2.5 text-sm text-muted lg:table-cell">{a.lastActiveAt ? formatAgo(a.lastActiveAt, locale) : t("admin.accounts.never")}</td>
                  <td className={`${num} hidden xl:table-cell`}>{a.graphs}</td>
                  <td className={`${num} hidden xl:table-cell`}>{a.sources}</td>
                  <td className={`${num} hidden sm:table-cell text-muted`}>{formatBytes(a.bytes, locale)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-3 text-sm text-muted tabular-nums">{t("admin.accounts.shown", { count: rows.length })}</p>
    </>
  );
}
