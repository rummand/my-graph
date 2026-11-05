/**
 * Payments for the public paid plans (server-only). Stripe Checkout to start a subscription, the Customer Portal to
 * change or cancel it, and a webhook (see events.ts) that keeps account_plans in step. Ultimate and its add-ons are
 * never sold or shown: they stay admin-assigned, and billing never changes an account that is on Ultimate.
 *
 * Without Stripe in the environment everything here reports "not set up" and no payment control is offered.
 */
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { accountPlans } from "@/db/schema";
import type { Viewer } from "@/lib/auth";
import { ULTIMATE } from "@/lib/plans/catalog";
import {
  BILLING_MANAGED_PLANS, SELLABLE_PLANS, billingConfigured, mayBuy, priceFor, priceTable, stripeMode, type Interval,
} from "./config";
import { entitledPlan } from "./state";
import { StripeError, stripeClient, type StripeClient } from "./stripe";
import { billingFor, linkCustomer } from "./store";

export { billingConfigured, stripeMode, SELLABLE_PLANS, type Interval } from "./config";
export { StripeError } from "./stripe";

export class BillingError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "BillingError";
  }
}

async function ownPlan(userId: string): Promise<string | null> {
  const [r] = await db.select({ planKey: accountPlans.planKey }).from(accountPlans).where(eq(accountPlans.userId, userId)).limit(1);
  return r?.planKey ?? null;
}

export type PriceView = { plan: string; interval: Interval; amount: number | null; currency: string | null };

const g = globalThis as unknown as { __mgBillingPrices?: { at: number; key: string; prices: PriceView[] } };

/** Amounts for the configured prices, from Stripe (cached for an hour). Amounts are null if Stripe can't be read. */
export async function listPrices(client: StripeClient = stripeClient()): Promise<PriceView[]> {
  const table = priceTable();
  const key = table.map((p) => p.priceId).join(",");
  const c = g.__mgBillingPrices;
  if (c && c.key === key && Date.now() - c.at < 3_600_000) return c.prices;
  const prices = await Promise.all(table.map(async (p): Promise<PriceView> => {
    try {
      const r = await client.request<{ unit_amount?: number | null; currency?: string }>("GET", `/v1/prices/${encodeURIComponent(p.priceId)}`);
      return { plan: p.plan, interval: p.interval, amount: typeof r.unit_amount === "number" ? r.unit_amount : null, currency: r.currency ?? null };
    } catch {
      return { plan: p.plan, interval: p.interval, amount: null, currency: null };
    }
  }));
  if (prices.some((p) => p.amount !== null)) g.__mgBillingPrices = { at: Date.now(), key, prices };
  return prices;
}

export type BillingSummary = {
  configured: boolean;
  /** The person is on Ultimate (or another plan billing doesn't manage): no payment controls at all. */
  managedElsewhere: boolean;
  /** Plans this person may buy for their own account (empty while subscribed: changes go through the portal). */
  canBuy: string[];
  subscribed: boolean;
  hasCustomer: boolean;
  plan: string | null;
  interval: Interval | null;
  status: string | null;
  renewsAt: string | null;
  endsAt: string | null;
  heldPlan: string | null;
  heldUntil: string | null;
  graceUntil: string | null;
};

const LIVE = new Set(["active", "trialing", "past_due", "unpaid", "incomplete", "paused"]);

/** What the Plan section shows. Never includes Ultimate as something to buy. */
export async function billingSummary(v: Pick<Viewer, "id" | "role">): Promise<BillingSummary> {
  const configured = billingConfigured();
  const [own, b] = await Promise.all([ownPlan(v.id), billingFor(v.id).catch(() => null)]);
  const managedElsewhere = own === ULTIMATE || (!!own && !BILLING_MANAGED_PLANS.includes(own));
  const subscribed = !!b?.stripeSubscriptionId && !!b.status && LIVE.has(b.status);
  const now = new Date();
  const canBuy = configured && !managedElsewhere && !subscribed
    ? SELLABLE_PLANS.filter((p) => mayBuy({ role: v.role, ownPlan: own, plan: p }) && (priceFor(p, "month") || priceFor(p, "year")))
    : [];
  const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
  return {
    configured, managedElsewhere, canBuy, subscribed, hasCustomer: !!b && !managedElsewhere,
    plan: subscribed ? b!.planKey : null, interval: subscribed ? b!.interval : null, status: subscribed ? b!.status : null,
    renewsAt: subscribed && !b!.cancelAtPeriodEnd ? iso(b!.currentPeriodEnd) : null,
    endsAt: subscribed && b!.cancelAtPeriodEnd ? iso(b!.currentPeriodEnd) : null,
    heldPlan: subscribed && b!.heldUntil && b!.heldUntil > now && entitledPlan(b!, now) === b!.heldPlanKey ? b!.heldPlanKey : null,
    heldUntil: subscribed && b!.heldUntil && b!.heldUntil > now ? iso(b!.heldUntil) : null,
    graceUntil: subscribed && b!.graceUntil && b!.graceUntil > now ? iso(b!.graceUntil) : null,
  };
}

function stripeLocale(locale: string): string {
  return locale === "da" ? "da" : locale === "en" ? "en" : "auto";
}

async function ensureCustomer(v: Pick<Viewer, "id" | "email" | "name" | "householdId">, client: StripeClient): Promise<string> {
  const b = await billingFor(v.id);
  if (b) return b.stripeCustomerId;
  const email = /@/.test(v.email) ? v.email : undefined; // usernames aren't email addresses
  const c = await client.request<{ id: string }>("POST", "/v1/customers", {
    name: v.name, email, metadata: { userId: v.id, householdId: v.householdId },
  }, { idempotencyKey: `mg-customer-${v.id}` });
  await linkCustomer(v.id, c.id);
  const again = await billingFor(v.id); // a parallel request may have linked another one first
  return again?.stripeCustomerId ?? c.id;
}

/** Start Stripe Checkout for a plan. Refuses hidden plans, plans the person may not buy, and a second subscription. */
export async function startCheckout(v: Viewer, i: { plan: string; interval: Interval; baseUrl: string; locale: string }, client: StripeClient = stripeClient()): Promise<{ url: string }> {
  if (!billingConfigured()) throw new BillingError(503, "Payments aren't set up yet.");
  const s = await billingSummary(v);
  if (s.managedElsewhere) throw new BillingError(409, "Your plan is managed for you, so there is nothing to buy.");
  if (s.subscribed) throw new BillingError(409, "You already pay for a plan. Use Manage subscription to change it.");
  const price = priceFor(i.plan, i.interval);
  if (!price) throw new BillingError(400, "That plan can't be bought.");
  if (!s.canBuy.includes(i.plan)) {
    throw new BillingError(403, i.plan === "family" ? "Only the household owner can buy Family." : "Ask the household owner to change your plan.");
  }
  const customer = await ensureCustomer(v, client);
  const session = await client.request<{ url?: string }>("POST", "/v1/checkout/sessions", {
    mode: "subscription",
    customer,
    client_reference_id: v.id,
    line_items: [{ price, quantity: 1 }],
    subscription_data: { metadata: { userId: v.id, plan: i.plan } },
    metadata: { userId: v.id, plan: i.plan },
    allow_promotion_codes: true,
    locale: stripeLocale(i.locale),
    success_url: `${i.baseUrl}/settings?billing=success#plan`,
    cancel_url: `${i.baseUrl}/settings?billing=cancelled#plan`,
  });
  if (!session.url) throw new BillingError(502, "The payment page didn't open. Try again.");
  return { url: session.url };
}

/** Open the Stripe Customer Portal (change plan, card, invoices, cancel). */
export async function openPortal(v: Viewer, i: { baseUrl: string; locale: string }, client: StripeClient = stripeClient()): Promise<{ url: string }> {
  if (!billingConfigured()) throw new BillingError(503, "Payments aren't set up yet.");
  const own = await ownPlan(v.id);
  if (own === ULTIMATE) throw new BillingError(409, "Your plan is managed for you, so there is nothing to manage here.");
  const b = await billingFor(v.id);
  if (!b) throw new BillingError(404, "You don't pay for a plan yet.");
  const session = await client.request<{ url?: string }>("POST", "/v1/billing_portal/sessions", {
    customer: b.stripeCustomerId,
    return_url: `${i.baseUrl}/settings#plan`,
    locale: stripeLocale(i.locale),
    configuration: process.env.STRIPE_PORTAL_CONFIGURATION?.trim() || undefined,
  });
  if (!session.url) throw new BillingError(502, "The subscription page didn't open. Try again.");
  return { url: session.url };
}

/** The site's public base URL for Stripe's return links: APP_URL, else the request's own (proxy-aware) origin. */
export function baseUrlFrom(req: Request): string {
  const app = process.env.APP_URL?.trim();
  if (app) return app.replace(/\/$/, "");
  const h = req.headers;
  const host = h.get("x-forwarded-host")?.split(",")[0]?.trim() || h.get("host");
  const proto = h.get("x-forwarded-proto")?.split(",")[0]?.trim() || new URL(req.url).protocol.replace(":", "");
  return host ? `${proto}://${host}` : new URL(req.url).origin;
}

/**
 * Stop billing for an account that is being deleted: cancel its subscription at once (no further invoices). A
 * subscription Stripe no longer has counts as cancelled. Throws StripeError on any other failure, so the caller can
 * record it for the admin. Never logs or returns the key.
 */
export async function cancelSubscriptionNow(subscriptionId: string, client: StripeClient = stripeClient()): Promise<"cancelled" | "already"> {
  try {
    await client.request("DELETE", `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`, undefined, { idempotencyKey: `mg-delete-${subscriptionId}` });
    return "cancelled";
  } catch (e) {
    if (e instanceof StripeError && (e.status === 404 || e.code === "resource_missing")) return "already";
    throw e;
  }
}

export function isStripeError(e: unknown): e is StripeError {
  return e instanceof StripeError;
}

export function billingMode() {
  return { configured: billingConfigured(), mode: stripeMode(), prices: priceTable().map((p) => ({ plan: p.plan, interval: p.interval })) };
}
