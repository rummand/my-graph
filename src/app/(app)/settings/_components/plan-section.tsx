import { Check } from "lucide-react";
import { clsx } from "clsx";
import { Badge } from "@/components/ui";
import type { Viewer } from "@/lib/auth";
import { getEntitlements } from "@/lib/plans";
import { ULTIMATE, visibleAddons, visiblePlans } from "@/lib/plans/catalog";
import { getAdminT } from "@/lib/plans/i18n";
import { listPlans } from "@/lib/plans/store";
import { getT } from "@/lib/i18n";
import { Row } from "./section";

/**
 * "Plan": the person's own plan and what it includes, and the public plans for comparison. Hidden plans (Ultimate)
 * are never offered here, to anyone; someone who has Ultimate sees it as their own plan and nowhere else.
 */
export async function PlanSection({ v }: { v: Viewer }) {
  const [e, all, t, at] = await Promise.all([getEntitlements(v), listPlans().catch(() => []), getT(), getAdminT()]);
  if (!e) return null;
  const name = (key: string, fallback?: string) =>
    key === ULTIMATE ? at("admin.plans.ultimate") : t(`settings.plan.names.${key}`, undefined, fallback ?? key);
  const describe = (key: string, fallback?: string | null) =>
    key === ULTIMATE ? at("admin.plans.ultimateDescription") : t(`settings.plan.descriptions.${key}`, undefined, fallback ?? "");
  const mine = all.find((p) => p.key === e.planKey);
  const features = (mine?.features ?? []).filter((f) => f !== "admin_console");
  // Add-ons are personal: shown only to the person who has them, and only while they count (on their own Ultimate).
  const addons = e.planKey === ULTIMATE && !e.inherited ? visibleAddons(e.addons, { isAdmin: false }) : [];
  const options = visiblePlans(all, { isAdmin: false });
  const planName = name(e.planKey, e.planName);

  return (
    <Row id="plan-h" title={t("settings.plan.title")} lead={t("settings.plan.lead")}>
      <p className="text-lg font-semibold">{planName}</p>
      <p className="mt-0.5 text-sm text-muted">
        {e.inherited ? t("settings.plan.inherited", { plan: planName }) : t("settings.plan.yours", { plan: planName })}
        {" "}{describe(e.planKey, mine?.description)}
      </p>

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

      {options.length > 0 && (
        <div className="mt-6 border-t border-line pt-5">
          <h3 className="text-sm font-medium">{t("settings.plan.plans")}</h3>
          <ul className="mt-2 divide-y divide-line">
            {options.map((p) => {
              const current = p.key === e.planKey;
              return (
                <li key={p.key} className="flex items-baseline gap-3 py-2.5">
                  <span className={clsx("w-20 shrink-0", current ? "font-semibold" : "font-medium")}>{name(p.key, p.name)}</span>
                  <span className="min-w-0 flex-1 text-sm text-muted">{describe(p.key, p.description)}</span>
                  {current && <Badge tone="accent">{t("settings.plan.current")}</Badge>}
                </li>
              );
            })}
          </ul>
          <p className="mt-3 text-sm text-muted">{t("settings.plan.payments")}</p>
        </div>
      )}
    </Row>
  );
}
