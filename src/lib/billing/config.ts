/**
 * Which plans are sold, and the Stripe prices they map to (pure: no Next, no DB).
 *
 * Only public, paid plans from the catalog are ever sold: today Plus and Family. Free has no price, and Ultimate and
 * its add-ons are admin-assigned and never sold. That holds even if someone sets STRIPE_PRICE_ULTIMATE_MONTHLY: the
 * sellable list comes from the catalog, not from the environment.
 *
 * Environment (secrets come only from here and are never returned or logged):
 *   STRIPE_SECRET_KEY            sk_test_… or sk_live_…
 *   STRIPE_WEBHOOK_SECRET        whsec_… (from the webhook endpoint in Stripe)
 *   STRIPE_PRICE_PLUS_MONTHLY    price_… (and _YEARLY, and the same for FAMILY)
 *   STRIPE_PORTAL_CONFIGURATION  optional bpc_… (Customer Portal configuration to use)
 *   STRIPE_API_BASE              optional, for tests and mocks (default https://api.stripe.com)
 *   BILLING_GRACE_DAYS           optional, days a failed payment keeps the plan (default 7)
 */
import { ADDON_KEYS, DEFAULT_PLAN, PLAN_CATALOG, ULTIMATE } from "@/lib/plans/catalog";

export type Interval = "month" | "year";
export const INTERVALS: Interval[] = ["month", "year"];
export type BillingEnv = Record<string, string | undefined>;

/** Plans that can be bought: public, not Free, never Ultimate or an add-on. */
export const SELLABLE_PLANS: string[] = PLAN_CATALOG
  .filter((p) => p.public && p.key !== DEFAULT_PLAN && p.key !== ULTIMATE && !ADDON_KEYS.includes(p.key))
  .sort((a, b) => a.sort - b.sort)
  .map((p) => p.key);

/** Public plans billing may set or clear on account_plans. Anything else (Ultimate, custom plans) billing never touches. */
export const BILLING_MANAGED_PLANS: string[] = PLAN_CATALOG.filter((p) => p.public && p.key !== ULTIMATE).map((p) => p.key);

export function isSellable(plan: string): boolean {
  return SELLABLE_PLANS.includes(plan);
}

/** Order of plans for telling an upgrade from a downgrade (the catalog's sort; unknown plans rank lowest). */
export function planRank(plan: string | null | undefined): number {
  if (!plan) return 0;
  return PLAN_CATALOG.find((p) => p.key === plan)?.sort ?? 0;
}

function envName(plan: string, interval: Interval): string {
  return `STRIPE_PRICE_${plan.toUpperCase()}_${interval === "month" ? "MONTHLY" : "YEARLY"}`;
}

export type PriceEntry = { plan: string; interval: Interval; priceId: string };

/** The price ids configured for sellable plans. */
export function priceTable(env: BillingEnv = process.env): PriceEntry[] {
  const out: PriceEntry[] = [];
  for (const plan of SELLABLE_PLANS) {
    for (const interval of INTERVALS) {
      const id = env[envName(plan, interval)]?.trim();
      if (id) out.push({ plan, interval, priceId: id });
    }
  }
  return out;
}

export function priceFor(plan: string, interval: Interval, env: BillingEnv = process.env): string | null {
  if (!isSellable(plan)) return null;
  return priceTable(env).find((p) => p.plan === plan && p.interval === interval)?.priceId ?? null;
}

/** Which plan a Stripe price stands for (null: not one of ours, or not sellable). */
export function planForPrice(priceId: string | null | undefined, env: BillingEnv = process.env): PriceEntry | null {
  if (!priceId) return null;
  return priceTable(env).find((p) => p.priceId === priceId) ?? null;
}

/** Payments are set up when Stripe's key, the webhook secret and at least one price are present. */
export function billingConfigured(env: BillingEnv = process.env): boolean {
  return !!env.STRIPE_SECRET_KEY?.trim() && !!env.STRIPE_WEBHOOK_SECRET?.trim() && priceTable(env).length > 0;
}

/** test | live | null, from the key's prefix (the key itself is never exposed). */
export function stripeMode(env: BillingEnv = process.env): "test" | "live" | null {
  const k = env.STRIPE_SECRET_KEY?.trim() ?? "";
  if (/^(sk|rk)_test_/.test(k)) return "test";
  if (/^(sk|rk)_live_/.test(k)) return "live";
  return null;
}

export function graceDays(env: BillingEnv = process.env): number {
  const n = Number(env.BILLING_GRACE_DAYS);
  return Number.isFinite(n) && n >= 0 && n <= 60 ? n : 7;
}

/** Who may buy which plan for their own account. Family is for the whole household, so only its owner buys it. */
export function mayBuy(i: { role: string; ownPlan: string | null; plan: string }): boolean {
  if (!isSellable(i.plan)) return false;
  if (i.ownPlan && !BILLING_MANAGED_PLANS.includes(i.ownPlan)) return false; // on Ultimate (or a custom plan): nothing to buy
  if (i.role === "owner") return true;
  if (i.role === "parent") return i.plan !== "family";
  return false;
}
