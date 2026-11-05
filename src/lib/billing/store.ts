/**
 * Billing storage on Postgres (server-only, no Next imports so scripts can use it): the BillingStore the webhook
 * processor runs against, keeping account_plans in step with billing, and the reads for settings and the admin console.
 */
import { and, desc, eq, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { accountPlans, billingAccounts, billingEvents, households, users } from "@/db/schema";
import { BILLING_MANAGED_PLANS, type Interval } from "./config";
import type { BillingStore, StoredBilling } from "./events";
import { entitledPlan, nextReview, planAction, type BillingState } from "./state";

type Row = typeof billingAccounts.$inferSelect;

export function rowToState(r: Row): StoredBilling {
  return {
    userId: r.userId, stripeCustomerId: r.stripeCustomerId, stripeSubscriptionId: r.stripeSubscriptionId, planKey: r.planKey,
    interval: r.interval === "month" || r.interval === "year" ? (r.interval as Interval) : null, status: r.status,
    currentPeriodEnd: r.currentPeriodEnd, cancelAtPeriodEnd: r.cancelAtPeriodEnd, heldPlanKey: r.heldPlanKey,
    heldUntil: r.heldUntil, graceUntil: r.graceUntil, subscriptionEventAt: r.subscriptionEventAt,
  };
}

export async function billingFor(userId: string): Promise<StoredBilling | null> {
  const [r] = await db.select().from(billingAccounts).where(eq(billingAccounts.userId, userId)).limit(1);
  return r ? rowToState(r) : null;
}

/** Link an account to its Stripe customer (first checkout). */
export async function linkCustomer(userId: string, stripeCustomerId: string): Promise<void> {
  await db.insert(billingAccounts).values({ userId, stripeCustomerId }).onConflictDoNothing();
}

/** Apply what billing entitles to account_plans (never touching Ultimate or an admin-given plan). */
export async function reconcilePlan(userId: string, now = new Date()): Promise<void> {
  const [b] = await db.select().from(billingAccounts).where(eq(billingAccounts.userId, userId)).limit(1);
  if (!b) return;
  const state = rowToState(b);
  const [current] = await db.select({ planKey: accountPlans.planKey, assignedBy: accountPlans.assignedBy })
    .from(accountPlans).where(eq(accountPlans.userId, userId)).limit(1);
  const action = planAction(current ?? null, entitledPlan(state, now), BILLING_MANAGED_PLANS);
  if (action.kind === "set") {
    await db.insert(accountPlans).values({ userId, planKey: action.planKey, assignedBy: null })
      .onConflictDoUpdate({ target: accountPlans.userId, set: { planKey: action.planKey, assignedBy: null, assignedAt: now } });
  } else if (action.kind === "clear") {
    await db.delete(accountPlans).where(and(eq(accountPlans.userId, userId), isNull(accountPlans.assignedBy)));
  }
  await db.update(billingAccounts).set({ reviewAt: nextReview(state, now) }).where(eq(billingAccounts.userId, userId));
}

const g = globalThis as unknown as { __mgBillingSweep?: number };

/**
 * Apply holds and grace periods that ran out since the last webhook (at most once a minute per process). Called when
 * plans are resolved, so a lapsed plan changes on the next request without a scheduler.
 */
export async function sweepDueBilling(now = new Date()): Promise<number> {
  if (g.__mgBillingSweep && now.getTime() - g.__mgBillingSweep < 60_000) return 0;
  g.__mgBillingSweep = now.getTime();
  const due = await db.select({ userId: billingAccounts.userId }).from(billingAccounts)
    .where(and(isNotNull(billingAccounts.reviewAt), lte(billingAccounts.reviewAt, now))).limit(50);
  for (const d of due) await reconcilePlan(d.userId, now);
  return due.length;
}

const STALE_CLAIM_MS = 2 * 60_000;

export const pgBillingStore: BillingStore = {
  async claimEvent(e, now) {
    await db.insert(billingEvents).values({ id: e.id, type: e.type, stripeCreatedAt: e.created }).onConflictDoNothing();
    const claimed = await db.update(billingEvents)
      .set({ claimedAt: now, attempts: sql`${billingEvents.attempts} + 1` })
      .where(and(eq(billingEvents.id, e.id), isNull(billingEvents.processedAt),
        or(isNull(billingEvents.claimedAt), lt(billingEvents.claimedAt, new Date(now.getTime() - STALE_CLAIM_MS)))))
      .returning({ id: billingEvents.id });
    if (claimed.length) return "claimed";
    const [row] = await db.select({ processedAt: billingEvents.processedAt }).from(billingEvents).where(eq(billingEvents.id, e.id)).limit(1);
    return row?.processedAt ? "done" : "busy";
  },
  async finishEvent(id, userId) {
    await db.update(billingEvents).set({ processedAt: new Date(), error: null, userId, claimedAt: null }).where(eq(billingEvents.id, id));
  },
  async failEvent(id, error) {
    await db.update(billingEvents).set({ error, claimedAt: null }).where(eq(billingEvents.id, id));
  },
  async byCustomer(customerId) {
    const [r] = await db.select().from(billingAccounts).where(eq(billingAccounts.stripeCustomerId, customerId)).limit(1);
    return r ? rowToState(r) : null;
  },
  byUser: billingFor,
  async userExists(userId) {
    const [u] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1);
    return !!u;
  },
  async save(userId, s: BillingState, subscriptionEventAt) {
    const values = {
      stripeCustomerId: s.stripeCustomerId, stripeSubscriptionId: s.stripeSubscriptionId, planKey: s.planKey, interval: s.interval,
      status: s.status, currentPeriodEnd: s.currentPeriodEnd, cancelAtPeriodEnd: s.cancelAtPeriodEnd, heldPlanKey: s.heldPlanKey,
      heldUntil: s.heldUntil, graceUntil: s.graceUntil, subscriptionEventAt, updatedAt: new Date(),
    };
    await db.insert(billingAccounts).values({ userId, ...values })
      .onConflictDoUpdate({ target: billingAccounts.userId, set: values });
  },
  reconcile: reconcilePlan,
};

export type AdminBillingRow = StoredBilling & {
  name: string; email: string; householdName: string; accountPlan: string | null; updatedAt: string;
};

/** Every account with billing, newest change first (admin console). Metadata only; no card or invoice data is stored. */
export async function listBillingAccounts(limit = 300): Promise<AdminBillingRow[]> {
  const rows = await db.select({ b: billingAccounts, name: users.name, email: users.email, householdName: households.name, accountPlan: accountPlans.planKey })
    .from(billingAccounts)
    .innerJoin(users, eq(users.id, billingAccounts.userId))
    .innerJoin(households, eq(households.id, users.householdId))
    .leftJoin(accountPlans, eq(accountPlans.userId, billingAccounts.userId))
    .orderBy(desc(billingAccounts.updatedAt)).limit(limit);
  return rows.map((r) => ({
    ...rowToState(r.b), name: r.name, email: r.email, householdName: r.householdName, accountPlan: r.accountPlan,
    updatedAt: r.b.updatedAt.toISOString(),
  }));
}

export async function recentBillingEvents(limit = 50) {
  return db.select({
    id: billingEvents.id, type: billingEvents.type, userId: billingEvents.userId, receivedAt: billingEvents.receivedAt,
    processedAt: billingEvents.processedAt, attempts: billingEvents.attempts, error: billingEvents.error,
  }).from(billingEvents).orderBy(desc(billingEvents.receivedAt)).limit(limit);
}
