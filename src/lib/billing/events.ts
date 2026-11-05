/**
 * Webhook event processing, written against a small storage interface so the rules (idempotency, ordering, which
 * account an event belongs to, what each event does) are tested without a database. store.ts implements it on
 * Postgres; tests use an in-memory one.
 */
import { graceDays as graceDaysFrom, type BillingEnv } from "./config";
import { applySubscription, clearGrace, customerId, startGrace, type BillingState, type StripeSubscription } from "./state";
import type { StripeClient } from "./stripe";

export type StripeEvent = {
  id: string;
  type: string;
  created: number;
  livemode?: boolean;
  data: { object: Record<string, unknown> & { object?: string } };
};

export type StoredBilling = BillingState & { userId: string; subscriptionEventAt: Date | null };

export interface BillingStore {
  /** Record the event and claim it. "done": already processed (skip). "busy": another worker has it right now. */
  claimEvent(e: { id: string; type: string; created: Date }, now: Date): Promise<"claimed" | "done" | "busy">;
  finishEvent(id: string, userId: string | null): Promise<void>;
  failEvent(id: string, error: string): Promise<void>;
  byCustomer(customerId: string): Promise<StoredBilling | null>;
  byUser(userId: string): Promise<StoredBilling | null>;
  userExists(userId: string): Promise<boolean>;
  save(userId: string, s: BillingState, subscriptionEventAt: Date | null): Promise<void>;
  /** Bring account_plans in line with the stored billing state. */
  reconcile(userId: string, now: Date): Promise<void>;
}

export const HANDLED_EVENTS = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
  "invoice.payment_failed",
  "invoice.paid",
] as const;

export type ProcessResult = { outcome: "processed" | "duplicate" | "busy" | "ignored"; userId?: string | null };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function str(x: unknown): string | null {
  return typeof x === "string" && x ? x : null;
}

/** Which account an event belongs to: the one already linked to the Stripe customer, else the user id we put in metadata. */
async function resolveUser(store: BillingStore, customer: string | null, metaUser: string | null): Promise<{ userId: string; row: StoredBilling | null } | null> {
  if (customer) {
    const row = await store.byCustomer(customer);
    if (row) return { userId: row.userId, row };
  }
  if (metaUser && UUID.test(metaUser) && await store.userExists(metaUser)) {
    const row = await store.byUser(metaUser);
    // An account already linked to another customer isn't re-linked by metadata alone.
    if (row && customer && row.stripeCustomerId !== customer) return null;
    return { userId: metaUser, row };
  }
  return null;
}

function emptyState(customer: string): BillingState {
  return {
    stripeCustomerId: customer, stripeSubscriptionId: null, planKey: null, interval: null, status: null,
    currentPeriodEnd: null, cancelAtPeriodEnd: false, heldPlanKey: null, heldUntil: null, graceUntil: null,
  };
}

async function applySub(store: BillingStore, sub: StripeSubscription, created: Date, now: Date, env: BillingEnv): Promise<string | null> {
  const cust = customerId(sub.customer);
  const who = await resolveUser(store, cust, str(sub.metadata?.userId));
  if (!who) return null;
  const prev = who.row;
  // Out of order: an older event about the subscription than one already applied changes nothing.
  if (prev?.subscriptionEventAt && created < prev.subscriptionEventAt && prev.stripeSubscriptionId === sub.id) return who.userId;
  // An old subscription ending doesn't undo a newer one.
  const ending = ["canceled", "incomplete_expired"].includes(sub.status);
  if (prev?.stripeSubscriptionId && prev.stripeSubscriptionId !== sub.id && ending) return who.userId;
  const next = applySubscription(prev, sub, now, { graceDays: graceDaysFrom(env), env });
  if (!next.stripeCustomerId) next.stripeCustomerId = cust ?? prev?.stripeCustomerId ?? "";
  await store.save(who.userId, next, created);
  await store.reconcile(who.userId, now);
  return who.userId;
}

async function handle(store: BillingStore, e: StripeEvent, now: Date, env: BillingEnv, client: StripeClient | null): Promise<string | null> {
  const obj = e.data.object;
  const created = new Date(e.created * 1000);
  switch (e.type) {
    case "checkout.session.completed": {
      if (obj.mode !== "subscription") return null;
      const cust = str(obj.customer);
      if (!cust) return null;
      const meta = (obj.metadata ?? {}) as Record<string, string>;
      const who = await resolveUser(store, cust, str(obj.client_reference_id) ?? str(meta.userId));
      if (!who) return null;
      if (!who.row) await store.save(who.userId, emptyState(cust), null);
      // Fetch the subscription so the plan applies as soon as they're back, not when the next event arrives.
      const subId = str(obj.subscription);
      if (subId && client) {
        const sub = await client.request<StripeSubscription>("GET", `/v1/subscriptions/${encodeURIComponent(subId)}`);
        await applySub(store, { ...sub, metadata: { ...(sub.metadata ?? {}), userId: who.userId } }, created, now, env);
      }
      return who.userId;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
    case "customer.subscription.paused":
    case "customer.subscription.resumed":
      return applySub(store, obj as unknown as StripeSubscription, created, now, env);
    case "invoice.payment_failed":
    case "invoice.paid": {
      const cust = str(obj.customer);
      const row = cust ? await store.byCustomer(cust) : null;
      if (!row) return null;
      const sub = str(obj.subscription);
      if (sub && row.stripeSubscriptionId && sub !== row.stripeSubscriptionId) return row.userId;
      const next = e.type === "invoice.paid" ? clearGrace(row) : startGrace(row, now, graceDaysFrom(env));
      await store.save(row.userId, next, row.subscriptionEventAt);
      await store.reconcile(row.userId, now);
      return row.userId;
    }
    default:
      return null;
  }
}

/** Process one verified event exactly once (by event id). Throws when it should be retried by Stripe. */
export async function processEvent(store: BillingStore, e: StripeEvent, opts: { now?: Date; env?: BillingEnv; client?: StripeClient | null } = {}): Promise<ProcessResult> {
  const now = opts.now ?? new Date();
  const env = opts.env ?? process.env;
  if (!(HANDLED_EVENTS as readonly string[]).includes(e.type)) return { outcome: "ignored" };
  const claim = await store.claimEvent({ id: e.id, type: e.type, created: new Date(e.created * 1000) }, now);
  if (claim === "done") return { outcome: "duplicate" };
  if (claim === "busy") return { outcome: "busy" };
  try {
    const userId = await handle(store, e, now, env, opts.client ?? null);
    await store.finishEvent(e.id, userId);
    return { outcome: "processed", userId };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Processing failed.";
    await store.failEvent(e.id, msg.slice(0, 500)).catch(() => undefined);
    throw err;
  }
}

/** Parse the webhook body into an event (after the signature checked out). */
export function parseEvent(raw: string): StripeEvent | null {
  try {
    const e = JSON.parse(raw) as StripeEvent;
    if (!e || typeof e.id !== "string" || typeof e.type !== "string" || typeof e.created !== "number" || !e.data || typeof e.data.object !== "object") return null;
    return e;
  } catch {
    return null;
  }
}
