import { Suspense } from "react";
import { Check, CircleAlert } from "lucide-react";
import type { Viewer } from "@/lib/auth";
import { billingSummary, listPrices, type BillingSummary } from "@/lib/billing";
import { priceFor } from "@/lib/billing/config";
import { getEntitlements } from "@/lib/plans";
import { ULTIMATE, visibleAddons, visiblePlans } from "@/lib/plans/catalog";
import { getAdminT } from "@/lib/plans/i18n";
import { listPlans } from "@/lib/plans/store";
import { getFormatDate, getT } from "@/lib/i18n";
import { CheckoutReturn, ManageSubscription, PlanOptions, type PlanOption } from "./billing-controls";
import { Row } from "./section";

const NO_BILLING: BillingSummary = {
  configured: false, managedElsewhere: false, canBuy: [], subscribed: false, hasCustomer: false, plan: null, interval: null,
  status: null, renewsAt: null, endsAt: null, heldPlan: null, heldUntil: null, graceUntil: null,
};

/**
 * "Plan": the person's own plan and what it includes, the public plans for comparison, and paying for them (Stripe).
 * Hidden plans (Ultimate) are never offered here, to anyone; someone who has Ultimate sees it as their own plan and
 * nowhere else, with no plan list and no upgrade or payment controls. Without Stripe set up there are no buttons.
 */
export async function PlanSection({ v }: { v: Viewer }) {
  const [e, all, t, at, fmt, b] = await Promise.all([
    getEntitlements(v), listPlans().catch(() => []), getT(), getAdminT(), getFormatDate(),
    billingSummary(v).catch((err) => { console.error("[billing] summary", err instanceof Error ? err.message : err); return NO_BILLING; }),
  ]);
  if (!e) return null;
  const name = (key: string, fallback?: string) =>
    key === ULTIMATE ? at("admin.plans.ultimate") : t(`settings.plan.names.${key}`, undefined, fallback ?? key);
  const describe = (key: string, fallback?: string | null) =>
    key === ULTIMATE ? at("admin.plans.ultimateDescription") : t(`settings.plan.descriptions.${key}`, undefined, fallback ?? "");
  const mine = all.find((p) => p.key === e.planKey);
  const features = (mine?.features ?? []).filter((f) => f !== "admin_console");
  // Add-ons are personal: shown only to the person who has them, and only while they count (on their own Ultimate).
  const addons = e.planKey === ULTIMATE && !e.inherited ? visibleAddons(e.addons, { isAdmin: false }) : [];
  const planName = name(e.planKey, e.planName);
  // On Ultimate (their own): nothing to compare, buy or upgrade to.
  const onUltimate = (e.planKey === ULTIMATE && !e.inherited) || b.managedElsewhere;
  const options = onUltimate ? [] : visiblePlans(all, { isAdmin: false });
  const prices = b.canBuy.length ? await listPrices().catch(() => []) : [];
  const intervals = (["month", "year"] as const).filter((iv) => b.canBuy.some((p) => priceFor(p, iv)));
  const planOptions: PlanOption[] = options.map((p) => ({
    key: p.key, name: name(p.key, p.name), description: describe(p.key, p.description), current: p.key === e.planKey,
    buyable: b.canBuy.includes(p.key),
    prices: Object.fromEntries(intervals.filter((iv) => priceFor(p.key, iv)).map((iv) => {
      const pr = prices.find((x) => x.plan === p.key && x.interval === iv);
      return [iv, { amount: pr?.amount ?? null, currency: pr?.currency ?? null }];
    })),
  }));
  const date = (iso: string | null) => (iso ? fmt(iso, "date").replace(/\.$/, "") : "");
  const billed = b.plan ? name(b.plan) : planName;
  const status = !b.subscribed || onUltimate ? null
    : b.graceUntil ? { warn: true, text: t("settings.plan.billing.grace", { date: date(b.graceUntil), plan: billed }) }
    : b.status === "incomplete" ? { warn: true, text: t("settings.plan.billing.incomplete") }
    : b.status === "paused" ? { warn: false, text: t("settings.plan.billing.paused") }
    : b.heldPlan && b.heldUntil ? { warn: false, text: t("settings.plan.billing.held", { held: name(b.heldPlan), date: date(b.heldUntil), plan: billed }) }
    : b.endsAt ? { warn: false, text: t("settings.plan.billing.ends", { plan: billed, date: date(b.endsAt) }) }
    : b.renewsAt ? { warn: false, text: t("settings.plan.billing.renews", { plan: billed, date: date(b.renewsAt), interval: t(`settings.plan.billing.intervals.${b.interval ?? "month"}`) }) }
    : null;
  const footer = onUltimate ? null
    : !b.configured ? t("settings.plan.billing.notSetUp")
    : !b.subscribed && !b.canBuy.length && !b.hasCustomer ? t("settings.plan.billing.askOwner")
    : null;

  return (
    <Row id="plan-h" title={t("settings.plan.title")} lead={t("settings.plan.lead")}>
      {b.configured && !onUltimate && <Suspense fallback={null}><CheckoutReturn /></Suspense>}
      <p className="text-lg font-semibold">{planName}</p>
      <p className="mt-0.5 text-sm text-muted">
        {e.inherited ? t("settings.plan.inherited", { plan: planName }) : t("settings.plan.yours", { plan: planName })}
        {" "}{describe(e.planKey, mine?.description)}
      </p>

      {status && (
        <p role={status.warn ? "alert" : undefined}
          className={status.warn ? "mt-3 flex items-start gap-2 rounded-md bg-warn-tint px-3 py-2 text-sm" : "mt-3 text-sm"}>
          {status.warn && <CircleAlert size={16} className="mt-0.5 shrink-0 text-warn" aria-hidden />}
          <span>{status.text}</span>
        </p>
      )}
      {b.configured && !onUltimate && (b.subscribed || b.hasCustomer) && <ManageSubscription />}

      {features.length > 0 && (
        <>
          <h3 className="mt-5 text-sm font-medium">{t("settings.plan.includes")}</h3>
          <ul className="mt-2 grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
            {features.map((f) => (
              <li key={f} className="flex items-start gap-2 text-sm">
                <Check size={16} className="mt-0.5 shrink-0 text-accent" aria-hidden />
                {t(`settings.plan.features.${f}`)}
              </li>
            ))}
          </ul>
        </>
      )}

      {addons.length > 0 && (
        <>
          <h3 className="mt-5 text-sm font-medium">{t("settings.plan.addons")}</h3>
          <ul className="mt-2 space-y-1.5">
            {addons.map((a) => (
              <li key={a} className="flex items-start gap-2 text-sm">
                <Check size={16} className="mt-0.5 shrink-0 text-accent" aria-hidden />
                <span><span className="font-medium">{at(`admin.addons.${a}`)}</span> <span className="text-muted">{at(`admin.addons.${a}Hint`)}</span></span>
              </li>
            ))}
          </ul>
        </>
      )}

      {planOptions.length > 0 && (
        <div className="mt-6 border-t border-line pt-5">
          <h3 className="text-sm font-medium">{t("settings.plan.plans")}</h3>
          <PlanOptions options={planOptions} intervals={intervals} />
          {footer && <p className="mt-3 text-sm text-muted">{footer}</p>}
        </div>
      )}
    </Row>
  );
}
