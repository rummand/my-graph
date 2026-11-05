/**
 * Subscription state and the plan it entitles (pure: no DB, no network, so every rule is testable).
 *
 * Rules
 * - Active or trialing: the subscription's plan.
 * - A downgrade (to a lower plan) while a paid period is running keeps the higher plan until that period ends.
 *   Configure the Customer Portal to schedule downgrades at period end and Stripe does this itself; the hold is the
 *   safety net when it doesn't.
 * - Cancelling at period end keeps the plan until Stripe ends the subscription (customer.subscription.deleted).
 * - A failed payment (past_due / unpaid) keeps the plan for a grace period from the first failure, then it lapses.
 * - Incomplete (first payment not made), paused, canceled, incomplete_expired: no paid plan.
 */
import { planForPrice, planRank, type BillingEnv, type Interval } from "./config";

export type BillingState = {
  stripeCustomerId: string;
  stripeSubscriptionId: string | null;
  planKey: string | null;
  interval: Interval | null;
  status: string | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  heldPlanKey: string | null;
  heldUntil: Date | null;
  graceUntil: Date | null;
};

/** The parts of a Stripe Subscription object we read (any API version: period end moved onto items in 2025). */
export type StripeSubscription = {
  id: string;
  object?: string;
  customer: string | { id: string };
  status: string;
  cancel_at_period_end?: boolean;
  current_period_end?: number | null;
  metadata?: Record<string, string> | null;
  items?: { data?: { price?: { id?: string; recurring?: { interval?: string } | null } | null; current_period_end?: number | null }[] };
};

const PAYING = new Set(["active", "trialing"]);
const GRACE = new Set(["past_due", "unpaid"]);

export function customerId(c: StripeSubscription["customer"] | null | undefined): string | null {
  if (!c) return null;
  return typeof c === "string" ? c : c.id ?? null;
}

function toDate(sec: number | null | undefined): Date | null {
  return typeof sec === "number" && Number.isFinite(sec) ? new Date(sec * 1000) : null;
}

export function readSubscription(sub: StripeSubscription, env?: BillingEnv) {
  const item = sub.items?.data?.[0];
  const priceId = item?.price?.id ?? null;
  const mapped = planForPrice(priceId, env);
  const iv = item?.price?.recurring?.interval;
  return {
    priceId,
    planKey: mapped?.plan ?? null,
    interval: (mapped?.interval ?? (iv === "month" || iv === "year" ? iv : null)) as Interval | null,
    currentPeriodEnd: toDate(sub.current_period_end ?? item?.current_period_end),
    status: sub.status,
    cancelAtPeriodEnd: !!sub.cancel_at_period_end,
  };
}

/** The plan this billing state gives right now (null: no paid plan). */
export function entitledPlan(s: Pick<BillingState, "planKey" | "status" | "heldPlanKey" | "heldUntil" | "graceUntil"> | null, now: Date): string | null {
  if (!s || !s.planKey || !s.status) return null;
  const held = s.heldPlanKey && s.heldUntil && now < s.heldUntil ? s.heldPlanKey : null;
  const plan = held && planRank(held) > planRank(s.planKey) ? held : s.planKey;
  if (PAYING.has(s.status)) return plan;
  if (GRACE.has(s.status)) return s.graceUntil && now < s.graceUntil ? plan : null;
  return null;
}

/** The next moment the entitlement changes on its own (a hold or grace period ending), if any. */
export function nextReview(s: Pick<BillingState, "heldUntil" | "graceUntil">, now: Date): Date | null {
  const times = [s.heldUntil, s.graceUntil].filter((d): d is Date => !!d && d > now).map((d) => d.getTime());
  return times.length ? new Date(Math.min(...times)) : null;
}

/** Fold a subscription object (from a webhook or a fetch) into the stored state. */
export function applySubscription(prev: BillingState | null, sub: StripeSubscription, now: Date, opts: { graceDays: number; env?: BillingEnv }): BillingState {
  const r = readSubscription(sub, opts.env);
  const cust = customerId(sub.customer) ?? prev?.stripeCustomerId ?? "";
  const base: BillingState = {
    stripeCustomerId: cust,
    stripeSubscriptionId: sub.id,
    // A price we don't know (removed from env, or not ours) keeps the plan we last knew rather than dropping it.
    planKey: r.planKey ?? (prev?.stripeSubscriptionId === sub.id ? prev.planKey : null),
    interval: r.interval ?? prev?.interval ?? null,
    status: r.status,
    currentPeriodEnd: r.currentPeriodEnd ?? prev?.currentPeriodEnd ?? null,
    cancelAtPeriodEnd: r.cancelAtPeriodEnd,
    heldPlanKey: prev?.heldPlanKey ?? null,
    heldUntil: prev?.heldUntil ?? null,
    graceUntil: prev?.graceUntil ?? null,
  };

  // Downgrade hold: the plan they were entitled to a moment ago, if higher, stays until the paid period ends.
  const before = entitledPlan(prev, now);
  const sameSub = prev?.stripeSubscriptionId === sub.id;
  if (sameSub && PAYING.has(r.status) && before && base.planKey && planRank(base.planKey) < planRank(before)
    && prev?.currentPeriodEnd && prev.currentPeriodEnd > now) {
    base.heldPlanKey = before;
    base.heldUntil = prev.heldUntil && prev.heldPlanKey === before ? prev.heldUntil : prev.currentPeriodEnd;
  }
  if (!sameSub || !base.planKey || (base.heldPlanKey && planRank(base.planKey) >= planRank(base.heldPlanKey))
    || (!PAYING.has(r.status) && !GRACE.has(r.status)) || (base.heldUntil && base.heldUntil <= now)) {
    base.heldPlanKey = null;
    base.heldUntil = null;
  }

  // Grace: starts at the first failure we see, ends when Stripe says it's paid again.
  if (GRACE.has(r.status)) base.graceUntil = base.graceUntil ?? addDays(now, opts.graceDays);
  else base.graceUntil = null;
  return base;
}

/** invoice.payment_failed: start the grace period (never extend one already running). */
export function startGrace(prev: BillingState, now: Date, days: number): BillingState {
  return { ...prev, graceUntil: prev.graceUntil ?? addDays(now, days) };
}

/** invoice.paid: the account is in good standing again. */
export function clearGrace(prev: BillingState): BillingState {
  return { ...prev, graceUntil: null };
}

export function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86_400_000);
}

/**
 * What to do with account_plans given the current row and the plan billing entitles. Billing only manages public
 * plans: an account on Ultimate (or any plan billing doesn't manage) is left exactly as it is. When billing entitles
 * nothing, it removes only a row it set itself (assignedBy null), so a plan an admin gave stays.
 */
export type PlanAction = { kind: "none" } | { kind: "set"; planKey: string } | { kind: "clear" };

export function planAction(current: { planKey: string; assignedBy: string | null } | null, entitled: string | null, managed: string[]): PlanAction {
  if (current && !managed.includes(current.planKey)) return { kind: "none" };
  if (entitled) return current?.planKey === entitled && current.assignedBy === null ? { kind: "none" } : { kind: "set", planKey: entitled };
  if (current && current.assignedBy === null && current.planKey !== "free") return { kind: "clear" };
  return { kind: "none" };
}
