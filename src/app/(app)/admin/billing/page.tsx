import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { Avatar, Badge, EmptyState } from "@/components/ui";
import { billingMode } from "@/lib/billing";
import { BILLING_MANAGED_PLANS } from "@/lib/billing/config";
import { entitledPlan } from "@/lib/billing/state";
import { listBillingAccounts, recentBillingEvents, sweepDueBilling } from "@/lib/billing/store";
import { requirePlatformAdmin } from "@/lib/plans/admin";
import { getAdminT } from "@/lib/plans/i18n";
import { formatAgo, getFormatDate, getLocale } from "@/lib/i18n";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getAdminT())("admin.nav.billing") };
}
export const dynamic = "force-dynamic";

type Tone = "neutral" | "accent" | "warn" | "danger";
const TONE: Record<string, Tone> = {
  active: "accent", trialing: "accent", past_due: "warn", unpaid: "danger", incomplete: "warn", paused: "neutral",
  canceled: "neutral", incomplete_expired: "neutral",
};

/** Billing per account (Stripe status, period, what My Graph applied) and the webhook's recent events. */
export default async function AdminBillingPage() {
  await requirePlatformAdmin();
  await sweepDueBilling().catch(() => 0);
  const [rows, events, t, fmt, locale, h] = await Promise.all([
    listBillingAccounts(), recentBillingEvents(), getAdminT(), getFormatDate(), getLocale(), headers(),
  ]);
  const mode = billingMode();
  const plan = (k: string | null) => (k ? t(`admin.plans.${k}`, undefined, k) : "—");
  const date = (d: Date | string | null) => (d ? fmt(d, "date") : "");
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const base = process.env.APP_URL?.replace(/\/$/, "") || (host ? `${h.get("x-forwarded-proto") ?? "https"}://${host}` : "");
  const now = new Date();
  const th = "px-3 py-2 text-left text-sm font-medium text-muted";

  return (
    <>
      <p className="mb-3 max-w-[60ch] text-sm text-muted">{t("admin.billing.lead")}</p>
      <div className="mb-6 rounded-lg bg-surface p-4 text-sm">
        {mode.configured ? (
          <p className="font-medium">{t("admin.billing.setUp", { mode: t(`admin.billing.modes.${mode.mode ?? "unknown"}`) })}</p>
        ) : (
          <p className="font-medium text-warn">{t("admin.billing.notSetUp")}</p>
        )}
        <p className="mt-1 text-muted">
          {mode.prices.length
            ? t("admin.billing.prices", { list: mode.prices.map((p) => `${plan(p.plan)} ${t(`admin.billing.intervals.${p.interval}`)}`).join(", ") })
            : t("admin.billing.noPrices")}
        </p>
        {base && <p className="mt-1 break-all text-muted">{t("admin.billing.webhook", { url: `${base}/api/webhooks/stripe` })}</p>}
      </div>

      {rows.length === 0 ? <EmptyState title={t("admin.billing.empty")} /> : (
        <div className="overflow-x-auto rounded-lg bg-surface">
          <table className="w-full min-w-0 border-collapse">
            <thead>
              <tr className="border-b border-line">
                <th className={th}>{t("admin.billing.cols.person")}</th>
                <th className={th}>{t("admin.billing.cols.status")}</th>
                <th className={`${th} hidden md:table-cell`}>{t("admin.billing.cols.billed")}</th>
                <th className={`${th} hidden lg:table-cell`}>{t("admin.billing.cols.period")}</th>
                <th className={`${th} hidden sm:table-cell`}>{t("admin.billing.cols.plan")}</th>
                <th className={`${th} hidden xl:table-cell`}>{t("admin.billing.cols.customer")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((r) => {
                const status = r.status ?? "none";
                const entitled = entitledPlan(r, now);
                return (
                  <tr key={r.userId} className="hover:bg-surface-2/60">
                    <td className="px-3 py-2.5">
                      <Link href={`/admin/accounts/${r.userId}`} className="flex min-w-0 items-center gap-2.5 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
                        <Avatar id={r.userId} name={r.name} size={28} />
                        <span className="min-w-0">
                          <span className="block max-w-[10rem] truncate font-medium sm:max-w-none">{r.name}</span>
                          <span className="block max-w-[11rem] truncate text-sm text-muted sm:max-w-none">{r.email}</span>
                        </span>
                      </Link>
                    </td>
                    <td className="px-3 py-2.5 text-sm">
                      <Badge tone={TONE[status] ?? "neutral"}>{t(`admin.billing.statuses.${status}`, undefined, status)}</Badge>
                      {r.graceUntil && r.graceUntil > now && <span className="mt-1 block text-xs text-warn">{t("admin.billing.grace", { date: date(r.graceUntil) })}</span>}
                    </td>
                    <td className="hidden px-3 py-2.5 text-sm md:table-cell">
                      {plan(r.planKey)}
                      {r.interval && <span className="block text-xs text-muted">{t(`admin.billing.intervals.${r.interval}`)}</span>}
                    </td>
                    <td className="hidden px-3 py-2.5 text-sm text-muted lg:table-cell">
                      {r.currentPeriodEnd && (r.cancelAtPeriodEnd ? t("admin.billing.ends", { date: date(r.currentPeriodEnd) }) : t("admin.billing.renews", { date: date(r.currentPeriodEnd) }))}
                      {r.heldPlanKey && r.heldUntil && r.heldUntil > now && <span className="block text-xs">{t("admin.billing.held", { plan: plan(r.heldPlanKey), date: date(r.heldUntil) })}</span>}
                    </td>
                    <td className="hidden px-3 py-2.5 text-sm sm:table-cell">
                      <span className="font-medium">{plan(r.accountPlan ?? "free")}</span>
                      {r.accountPlan && !BILLING_MANAGED_PLANS.includes(r.accountPlan)
                        ? <span className="block text-xs text-muted">{t("admin.billing.managedElsewhere")}</span>
                        : entitled && entitled !== r.accountPlan ? <span className="block text-xs text-warn">→ {plan(entitled)}</span> : null}
                    </td>
                    <td className="hidden px-3 py-2.5 font-mono text-xs text-muted xl:table-cell">{r.stripeCustomerId}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <h2 className="mb-3 mt-8 text-base font-semibold">{t("admin.billing.events")}</h2>
      {events.length === 0 ? <p className="text-sm text-muted">{t("admin.billing.eventsEmpty")}</p> : (
        <div className="overflow-x-auto rounded-lg bg-surface">
          <table className="w-full min-w-0 border-collapse">
            <thead>
              <tr className="border-b border-line">
                <th className={th}>{t("admin.billing.eventCols.received")}</th>
                <th className={th}>{t("admin.billing.eventCols.type")}</th>
                <th className={th}>{t("admin.billing.eventCols.result")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {events.map((e) => (
                <tr key={e.id}>
                  <td className="px-3 py-2 text-sm text-muted">{formatAgo(e.receivedAt, locale)}</td>
                  <td className="px-3 py-2 text-sm">
                    <span className="font-mono text-xs">{e.type}</span>
                    <span className="block font-mono text-xs text-muted">{e.id}</span>
                  </td>
                  <td className="px-3 py-2 text-sm">
                    {e.processedAt ? <Badge tone="accent">{t("admin.billing.processed")}</Badge>
                      : e.error ? <Badge tone="danger">{t("admin.billing.failed")}</Badge>
                      : <Badge>{t("admin.billing.pending")}</Badge>}
                    {e.attempts > 1 && <span className="ml-2 text-xs text-muted">{t("admin.billing.attempts", { count: e.attempts })}</span>}
                    {e.error && !e.processedAt && <span className="mt-1 block max-w-[40ch] text-xs text-muted">{e.error}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
