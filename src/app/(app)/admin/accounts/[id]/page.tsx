import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Avatar, Badge } from "@/components/ui";
import { AccountControls, type ControlsCopy } from "@/components/admin/account-controls";
import { AuditList } from "@/components/admin/audit-list";
import { formatBytes } from "@/components/admin/format";
import { requirePlatformAdmin } from "@/lib/plans/admin";
import { accountDetail } from "@/lib/plans/admin-data";
import { ADDONS, ULTIMATE, visiblePlans } from "@/lib/plans/catalog";
import { getAdminT } from "@/lib/plans/i18n";
import { listPlans } from "@/lib/plans/store";
import { formatAgo, getFormatDate, getLocale } from "@/lib/i18n";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  void params;
  return { title: (await getAdminT())("admin.nav.accounts") };
}
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function AdminAccountPage({ params }: { params: Promise<{ id: string }> }) {
  const v = await requirePlatformAdmin();
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const [a, allPlans, t, fmt, locale] = await Promise.all([accountDetail(id), listPlans(), getAdminT(), getFormatDate(), getLocale()]);
  if (!a) notFound();

  const plan = (k: string) => t(`admin.plans.${k}`, undefined, k);
  const role = t(`admin.roles.${a.role}`);
  const isSelf = a.id === v.id;
  const accessState = a.lockedAt
    ? (a.lockReason ? t("admin.account.access.lockedReason", { date: fmt(a.lockedAt, "dateTime"), reason: a.lockReason }) : t("admin.account.access.locked", { date: fmt(a.lockedAt, "dateTime") }))
    : a.tempPasswordPending ? t("admin.account.access.tempPending")
    : !a.hasPassword ? `${t("admin.account.access.unlocked")} ${t("admin.account.access.noPassword")}`
    : t("admin.account.access.unlocked");

  const copy: ControlsCopy = {
    planTitle: t("admin.account.plan.title"), planLead: t("admin.account.plan.lead"), planLabel: t("admin.account.plan.label"),
    planSave: t("admin.account.plan.save"), planSaved: t("admin.account.plan.saved"), planAdminFixed: t("admin.account.plan.adminFixed"),
    planInherited: a.planInherited ? t("admin.account.plan.inherited", { plan: plan(a.planKey) }) : "",
    planPayments: t("admin.account.plan.payments"),
    addonsTitle: t("admin.account.addons.title"), addonsLead: t("admin.account.addons.lead"),
    addonsNeedsUltimate: t("admin.account.addons.needsUltimate"), on: t("admin.account.addons.on"), off: t("admin.account.addons.off"),
    saved: t("admin.account.addons.saved"),
    accessTitle: t("admin.account.access.title"), accessLead: t("admin.account.access.lead"), accessState,
    reason: t("admin.account.access.reason"), reasonPlaceholder: t("admin.account.access.reasonPlaceholder"),
    lock: t("admin.account.access.lock"), lockConfirm: t("admin.account.access.lockConfirm", { name: a.name }),
    unlock: t("admin.account.access.unlock"), lockedDone: t("admin.account.access.lockedDone"),
    unlockedDone: t("admin.account.access.unlockedDone"), signOut: t("admin.account.access.signOut"),
    signOutConfirm: t("admin.account.access.signOutConfirm", { name: a.name }),
    signedOutOne: t("admin.account.access.signedOut", { count: 1 }).replace("1", "{count}"),
    signedOutOther: t("admin.account.access.signedOut", { count: 2 }).replace("2", "{count}"),
    selfNote: t("admin.account.access.selfNote"),
    pwTitle: t("admin.account.password.title"), pwLead: t("admin.account.password.lead"),
    resetLink: t("admin.account.password.resetLink"), resetLinkHint: t("admin.account.password.resetLinkHint"),
    resetReady: t("admin.account.password.resetReady", { name: a.name, date: "{date}" }),
    temp: t("admin.account.password.temp"), tempHint: t("admin.account.password.tempHint"),
    tempConfirm: t("admin.account.password.tempConfirm", { name: a.name }), tempReady: t("admin.account.password.tempReady", { name: a.name }),
    copy: t("admin.account.password.copy"), copied: t("admin.account.password.copied"), failed: t("admin.account.failed"),
  };

  const stats = [
    { label: t("admin.account.stats.graphs"), value: String(a.graphs) },
    { label: t("admin.account.stats.sources"), value: String(a.sources) },
    { label: t("admin.account.stats.storage"), value: formatBytes(a.bytes, locale) },
    { label: t("admin.account.stats.passkeys"), value: String(a.passkeys) },
    { label: t("admin.account.stats.sessions"), value: String(a.activeSessions) },
  ];

  return (
    <>
      <Link href="/admin" className="mb-5 inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg">
        <ArrowLeft size={16} aria-hidden />{t("admin.account.back")}
      </Link>

      <div className="mb-8 flex flex-wrap items-start gap-4">
        <Avatar id={a.id} name={a.name} size={48} />
        <div className="min-w-0 flex-1">
          <h2 className="flex flex-wrap items-center gap-2 text-[22px]/[1.2] font-semibold tracking-[-0.01em]">
            {a.name}
            <Badge tone={a.planKey === ULTIMATE ? "accent" : "neutral"}>{plan(a.planKey)}</Badge>
            {a.locked && <Badge tone="danger">{t("admin.accounts.locked")}</Badge>}
            {a.isPlatformAdmin && <Badge>{t("admin.accounts.admin")}</Badge>}
          </h2>
          <p className="text-muted">{a.email}</p>
          <p className="mt-1 text-sm text-muted">
            {t("admin.account.summary", { role, household: a.householdName, date: fmt(a.createdAt, "date").replace(/\.$/, "") })}{" "}
            {a.lastActiveAt ? t("admin.account.lastActive", { when: formatAgo(a.lastActiveAt, locale) }) : t("admin.account.neverActive")}.
          </p>
        </div>
      </div>

      <dl className="mb-10 grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3 lg:grid-cols-5">
        {stats.map((s) => (
          <div key={s.label}>
            <dt className="text-sm text-muted">{s.label}</dt>
            <dd className="text-lg font-semibold tabular-nums">{s.value}</dd>
          </div>
        ))}
      </dl>

      <AccountControls
        id={a.id}
        plans={visiblePlans(allPlans, { isAdmin: true }).map((p) => ({ key: p.key, name: plan(p.key) }))}
        planKey={a.planKey}
        ownPlan={a.ownPlan}
        addons={ADDONS.map((x) => ({
          key: x.key, group: x.group, label: t(`admin.addons.${x.key}`), hint: t(`admin.addons.${x.key}Hint`), on: a.addons.includes(x.key),
        }))}
        groups={{ practice: t("admin.addons.groups.practice"), insights: t("admin.addons.groups.insights") }}
        locked={a.locked}
        isAdmin={a.isPlatformAdmin}
        isSelf={isSelf}
        copy={copy}
      />

      <div className="mt-10 grid gap-10 lg:grid-cols-2">
        <section aria-labelledby="hh">
          <h2 id="hh" className="mb-3 text-lg font-semibold">{t("admin.account.household")}</h2>
          {a.members.length === 0 ? <p className="text-sm text-muted">{t("admin.account.alone")}</p> : (
            <ul className="divide-y divide-line rounded-lg bg-surface px-4">
              {a.members.map((m) => (
                <li key={m.id}>
                  <Link href={`/admin/accounts/${m.id}`} className="flex items-center gap-2.5 py-2.5 hover:text-accent">
                    <Avatar id={m.id} name={m.name} size={24} />
                    <span className="flex-1 font-medium">{m.name}</span>
                    <span className="text-sm text-muted">{t(`admin.roles.${m.role}`)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section aria-labelledby="hist">
          <h2 id="hist" className="mb-3 text-lg font-semibold">{t("admin.account.history.title")}</h2>
          {a.recent.length === 0 ? <p className="text-sm text-muted">{t("admin.account.history.empty")}</p>
            : <AuditList rows={a.recent} compact />}
        </section>
      </div>
    </>
  );
}
