import { beforeEach, describe, expect, it, vi } from "vitest";

// No database in unit tests: the plan lookup in billingSummary reads "no own plan" unless a test sets one.
const dbState = vi.hoisted(() => ({ ownPlan: null as string | null }));
vi.mock("@/db", () => {
  const chain = { from: () => chain, where: () => chain, limit: async () => (dbState.ownPlan ? [{ planKey: dbState.ownPlan }] : []) };
  return { db: { select: () => chain } };
});
vi.mock("./store", () => ({ billingFor: vi.fn(async () => null), linkCustomer: vi.fn(async () => undefined) }));

import {
  BILLING_MANAGED_PLANS, SELLABLE_PLANS, billingConfigured, mayBuy, planForPrice, priceFor, priceTable, stripeMode,
} from "./config";
import { computeSignature, signPayload, verifySignature } from "./signature";
import { applySubscription, entitledPlan, planAction, type BillingState, type StripeSubscription } from "./state";
import { processEvent, type BillingStore, type StoredBilling, type StripeEvent } from "./events";
import { encodeForm, stripeClient, type StripeClient } from "./stripe";

const ENV = {
  STRIPE_SECRET_KEY: "sk_test_abc",
  STRIPE_WEBHOOK_SECRET: "whsec_test",
  STRIPE_PRICE_PLUS_MONTHLY: "price_plus_m",
  STRIPE_PRICE_PLUS_YEARLY: "price_plus_y",
  STRIPE_PRICE_FAMILY_MONTHLY: "price_family_m",
  STRIPE_PRICE_FAMILY_YEARLY: "price_family_y",
  STRIPE_PRICE_ULTIMATE_MONTHLY: "price_ultimate_m",
  STRIPE_PRICE_FREE_MONTHLY: "price_free_m",
};

describe("webhook signature", () => {
  const secret = "whsec_test";
  const body = JSON.stringify({ id: "evt_1", type: "invoice.paid" });
  const now = 1_800_000_000;

  it("accepts Stripe's signature over the raw body", () => {
    expect(verifySignature({ payload: body, header: signPayload(body, secret, now), secret, nowSec: now })).toEqual({ ok: true });
  });
  it("accepts when any of several v1 signatures matches (secret rotation)", () => {
    const header = `t=${now},v1=${"0".repeat(64)},v1=${computeSignature(body, now, secret)}`;
    expect(verifySignature({ payload: body, header, secret, nowSec: now }).ok).toBe(true);
  });
  it("refuses a changed body, a wrong secret, a missing or malformed header", () => {
    const header = signPayload(body, secret, now);
    expect(verifySignature({ payload: body.replace("evt_1", "evt_2"), header, secret, nowSec: now })).toEqual({ ok: false, reason: "mismatch" });
    expect(verifySignature({ payload: body, header, secret: "whsec_other", nowSec: now })).toEqual({ ok: false, reason: "mismatch" });
    expect(verifySignature({ payload: body, header: null, secret, nowSec: now })).toEqual({ ok: false, reason: "missing" });
    expect(verifySignature({ payload: body, header: "v1=abc", secret, nowSec: now })).toEqual({ ok: false, reason: "malformed" });
    expect(verifySignature({ payload: JSON.stringify(JSON.parse(body), null, 2), header, secret, nowSec: now }).ok).toBe(false);
  });
  it("refuses a replayed signature older than the tolerance", () => {
    const header = signPayload(body, secret, now - 301);
    expect(verifySignature({ payload: body, header, secret, nowSec: now })).toEqual({ ok: false, reason: "too_old" });
  });
});

describe("plans and prices", () => {
  it("sells only the public paid plans, never Free, Ultimate or an add-on", () => {
    expect(SELLABLE_PLANS).toEqual(["plus", "family"]);
    expect(BILLING_MANAGED_PLANS).not.toContain("ultimate");
  });
  it("maps prices both ways and ignores prices set for hidden or free plans", () => {
    expect(priceTable(ENV).map((p) => p.priceId)).toEqual(["price_plus_m", "price_plus_y", "price_family_m", "price_family_y"]);
    expect(priceFor("plus", "year", ENV)).toBe("price_plus_y");
    expect(priceFor("ultimate", "month", ENV)).toBeNull();
    expect(priceFor("free", "month", ENV)).toBeNull();
    expect(planForPrice("price_family_m", ENV)).toEqual({ plan: "family", interval: "month", priceId: "price_family_m" });
    expect(planForPrice("price_ultimate_m", ENV)).toBeNull();
    expect(planForPrice("price_unknown", ENV)).toBeNull();
  });
  it("is set up only with key, webhook secret and a price", () => {
    expect(billingConfigured(ENV)).toBe(true);
    expect(billingConfigured({ ...ENV, STRIPE_WEBHOOK_SECRET: "" })).toBe(false);
    expect(billingConfigured({ STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_x" })).toBe(false);
    expect(billingConfigured({})).toBe(false);
    expect(stripeMode(ENV)).toBe("test");
    expect(stripeMode({ STRIPE_SECRET_KEY: "sk_live_x" })).toBe("live");
  });
  it("lets the owner buy any paid plan, a parent Plus, nobody else, and nobody on Ultimate", () => {
    expect(mayBuy({ role: "owner", ownPlan: null, plan: "family" })).toBe(true);
    expect(mayBuy({ role: "parent", ownPlan: null, plan: "plus" })).toBe(true);
    expect(mayBuy({ role: "parent", ownPlan: null, plan: "family" })).toBe(false);
    expect(mayBuy({ role: "child", ownPlan: null, plan: "plus" })).toBe(false);
    expect(mayBuy({ role: "guest", ownPlan: null, plan: "plus" })).toBe(false);
    expect(mayBuy({ role: "owner", ownPlan: "ultimate", plan: "family" })).toBe(false);
    expect(mayBuy({ role: "owner", ownPlan: null, plan: "ultimate" })).toBe(false);
  });
});

const T0 = new Date("2026-11-01T00:00:00Z");
const sec = (d: Date) => Math.floor(d.getTime() / 1000);
const days = (n: number) => new Date(T0.getTime() + n * 86_400_000);

function sub(price: string, status = "active", extra: Partial<StripeSubscription> = {}): StripeSubscription {
  return {
    id: "sub_1", customer: "cus_1", status, cancel_at_period_end: false, current_period_end: sec(days(30)),
    metadata: { userId: USER }, items: { data: [{ price: { id: price, recurring: { interval: "month" } } }] }, ...extra,
  };
}

describe("subscription state", () => {
  const opts = { graceDays: 7, env: ENV };

  it("gives the subscribed plan while active, nothing when incomplete or cancelled", () => {
    const s = applySubscription(null, sub("price_family_m"), T0, opts);
    expect(s.planKey).toBe("family");
    expect(s.interval).toBe("month");
    expect(entitledPlan(s, T0)).toBe("family");
    expect(entitledPlan(applySubscription(null, sub("price_plus_m", "incomplete"), T0, opts), T0)).toBeNull();
    expect(entitledPlan(applySubscription(s, sub("price_family_m", "canceled"), T0, opts), T0)).toBeNull();
  });

  it("reads the period end from the item on newer API versions", () => {
    const s = applySubscription(null, { ...sub("price_plus_m"), current_period_end: undefined, items: { data: [{ price: { id: "price_plus_m" }, current_period_end: sec(days(10)) }] } }, T0, opts);
    expect(s.currentPeriodEnd?.toISOString()).toBe(days(10).toISOString());
  });

  it("keeps the plan until the period ends when cancelled at period end", () => {
    const s = applySubscription(null, sub("price_plus_m", "active", { cancel_at_period_end: true }), T0, opts);
    expect(s.cancelAtPeriodEnd).toBe(true);
    expect(entitledPlan(s, days(29))).toBe("plus");
  });

  it("holds a mid-period downgrade until the paid period ends", () => {
    const family = applySubscription(null, sub("price_family_m"), T0, opts);
    const down = applySubscription(family, sub("price_plus_m", "active", { current_period_end: sec(days(30)) }), days(5), opts);
    expect(down.planKey).toBe("plus");
    expect(down.heldPlanKey).toBe("family");
    expect(down.heldUntil?.toISOString()).toBe(days(30).toISOString());
    expect(entitledPlan(down, days(10))).toBe("family");
    expect(entitledPlan(down, days(31))).toBe("plus");
    // Upgrading again clears the hold.
    const up = applySubscription(down, sub("price_family_m"), days(6), opts);
    expect(up.heldPlanKey).toBeNull();
    expect(entitledPlan(up, days(6))).toBe("family");
  });

  it("upgrades straight away", () => {
    const plus = applySubscription(null, sub("price_plus_m"), T0, opts);
    const up = applySubscription(plus, sub("price_family_m"), days(3), opts);
    expect(up.heldPlanKey).toBeNull();
    expect(entitledPlan(up, days(3))).toBe("family");
  });

  it("keeps the plan through a failed-payment grace period, then lets it lapse", () => {
    const ok = applySubscription(null, sub("price_plus_m"), T0, opts);
    const late = applySubscription(ok, sub("price_plus_m", "past_due"), days(1), opts);
    expect(late.graceUntil?.toISOString()).toBe(days(8).toISOString());
    expect(entitledPlan(late, days(7))).toBe("plus");
    expect(entitledPlan(late, days(9))).toBeNull();
    // A second failure doesn't extend the grace period.
    expect(applySubscription(late, sub("price_plus_m", "past_due"), days(4), opts).graceUntil?.toISOString()).toBe(days(8).toISOString());
    // Paid again: grace cleared.
    expect(applySubscription(late, sub("price_plus_m"), days(5), opts).graceUntil).toBeNull();
  });

  it("never changes an account on Ultimate, and only clears a plan billing set itself", () => {
    const managed = BILLING_MANAGED_PLANS;
    expect(planAction({ planKey: "ultimate", assignedBy: "admin" }, "plus", managed)).toEqual({ kind: "none" });
    expect(planAction({ planKey: "ultimate", assignedBy: null }, null, managed)).toEqual({ kind: "none" });
    expect(planAction(null, "family", managed)).toEqual({ kind: "set", planKey: "family" });
    expect(planAction({ planKey: "family", assignedBy: null }, "family", managed)).toEqual({ kind: "none" });
    expect(planAction({ planKey: "family", assignedBy: null }, null, managed)).toEqual({ kind: "clear" });
    expect(planAction({ planKey: "plus", assignedBy: "admin" }, null, managed)).toEqual({ kind: "none" });
  });
});

const USER = "11111111-1111-4111-8111-111111111111";

/** An in-memory BillingStore with the same claim semantics as the Postgres one. */
function memoryStore() {
  const events = new Map<string, { processed: boolean; claimed: boolean; error?: string; attempts: number }>();
  const rows = new Map<string, StoredBilling>();
  const plans = new Map<string, { planKey: string; assignedBy: string | null }>();
  const saves: string[] = [];
  const store: BillingStore = {
    async claimEvent(e) {
      const cur = events.get(e.id);
      if (cur?.processed) return "done";
      if (cur?.claimed) return "busy";
      events.set(e.id, { processed: false, claimed: true, attempts: (cur?.attempts ?? 0) + 1 });
      return "claimed";
    },
    async finishEvent(id) { events.set(id, { ...events.get(id)!, processed: true, claimed: false }); },
    async failEvent(id, error) { events.set(id, { ...events.get(id)!, claimed: false, error }); },
    async byCustomer(c) { return [...rows.values()].find((r) => r.stripeCustomerId === c) ?? null; },
    async byUser(u) { return rows.get(u) ?? null; },
    async userExists(u) { return u === USER; },
    async save(userId, s: BillingState, at) { saves.push(userId); rows.set(userId, { ...s, userId, subscriptionEventAt: at }); },
    async reconcile(userId, now) {
      const r = rows.get(userId)!;
      const a = planAction(plans.get(userId) ?? null, entitledPlan(r, now), BILLING_MANAGED_PLANS);
      if (a.kind === "set") plans.set(userId, { planKey: a.planKey, assignedBy: null });
      if (a.kind === "clear") plans.delete(userId);
    },
  };
  return { store, events, rows, plans, saves };
}

function event(id: string, type: string, object: object, created = T0): StripeEvent {
  return { id, type, created: sec(created), data: { object: object as StripeEvent["data"]["object"] } };
}

describe("webhook events", () => {
  let m: ReturnType<typeof memoryStore>;
  beforeEach(() => { m = memoryStore(); });

  it("processes an event once, however often Stripe delivers it", async () => {
    const e = event("evt_a", "customer.subscription.created", sub("price_family_m"));
    expect((await processEvent(m.store, e, { now: T0, env: ENV })).outcome).toBe("processed");
    expect((await processEvent(m.store, e, { now: T0, env: ENV })).outcome).toBe("duplicate");
    expect((await processEvent(m.store, e, { now: T0, env: ENV })).outcome).toBe("duplicate");
    expect(m.saves).toHaveLength(1);
    expect(m.plans.get(USER)?.planKey).toBe("family");
  });

  it("retries an event whose processing failed, and doesn't run one that is being processed", async () => {
    const e = event("evt_b", "customer.subscription.created", sub("price_plus_m"));
    const failing = { ...m.store, save: async () => { throw new Error("database away"); } };
    await expect(processEvent(failing, e, { now: T0, env: ENV })).rejects.toThrow("database away");
    expect(m.events.get("evt_b")?.error).toBe("database away");
    expect((await processEvent(m.store, e, { now: T0, env: ENV })).outcome).toBe("processed");
    expect(m.plans.get(USER)?.planKey).toBe("plus");

    m.events.set("evt_c", { processed: false, claimed: true, attempts: 1 });
    expect((await processEvent(m.store, event("evt_c", "invoice.paid", { customer: "cus_1" }), { now: T0, env: ENV })).outcome).toBe("busy");
  });

  it("ignores events it doesn't handle, without recording them", async () => {
    expect((await processEvent(m.store, event("evt_d", "charge.refunded", {}), { now: T0, env: ENV })).outcome).toBe("ignored");
    expect(m.events.size).toBe(0);
  });

  it("ignores a subscription event older than one already applied", async () => {
    await processEvent(m.store, event("evt_new", "customer.subscription.updated", sub("price_family_m"), days(2)), { now: days(2), env: ENV });
    await processEvent(m.store, event("evt_old", "customer.subscription.updated", sub("price_plus_m"), days(1)), { now: days(2), env: ENV });
    expect(m.rows.get(USER)?.planKey).toBe("family");
    expect(m.plans.get(USER)?.planKey).toBe("family");
  });

  it("removes the plan when the subscription ends, and starts and clears grace on invoices", async () => {
    await processEvent(m.store, event("e1", "customer.subscription.created", sub("price_plus_m")), { now: T0, env: ENV });
    await processEvent(m.store, event("e2", "invoice.payment_failed", { customer: "cus_1", subscription: "sub_1" }, days(1)), { now: days(1), env: ENV });
    expect(m.rows.get(USER)?.graceUntil?.toISOString()).toBe(days(8).toISOString());
    await processEvent(m.store, event("e3", "invoice.paid", { customer: "cus_1", subscription: "sub_1" }, days(2)), { now: days(2), env: ENV });
    expect(m.rows.get(USER)?.graceUntil).toBeNull();
    await processEvent(m.store, event("e4", "customer.subscription.deleted", sub("price_plus_m", "canceled"), days(30)), { now: days(30), env: ENV });
    expect(m.plans.has(USER)).toBe(false);
  });

  it("never touches an account on Ultimate, whatever Stripe says", async () => {
    m.plans.set(USER, { planKey: "ultimate", assignedBy: "admin" });
    await processEvent(m.store, event("u1", "customer.subscription.created", sub("price_plus_m")), { now: T0, env: ENV });
    await processEvent(m.store, event("u2", "customer.subscription.deleted", sub("price_plus_m", "canceled"), days(1)), { now: days(1), env: ENV });
    expect(m.plans.get(USER)).toEqual({ planKey: "ultimate", assignedBy: "admin" });
  });

  it("refuses to link an account by metadata to a second customer", async () => {
    await processEvent(m.store, event("l1", "customer.subscription.created", sub("price_plus_m")), { now: T0, env: ENV });
    await processEvent(m.store, event("l2", "customer.subscription.created", { ...sub("price_family_m"), id: "sub_2", customer: "cus_evil" }, days(1)), { now: days(1), env: ENV });
    expect(m.rows.get(USER)?.stripeCustomerId).toBe("cus_1");
    expect(m.plans.get(USER)?.planKey).toBe("plus");
  });

  it("applies the subscription straight after checkout, fetched from Stripe", async () => {
    const client: StripeClient = { request: vi.fn(async () => sub("price_family_y") as never) };
    await processEvent(m.store, event("c1", "checkout.session.completed", {
      mode: "subscription", customer: "cus_1", subscription: "sub_1", client_reference_id: USER,
    }), { now: T0, env: ENV, client });
    expect(client.request).toHaveBeenCalledWith("GET", "/v1/subscriptions/sub_1");
    expect(m.plans.get(USER)?.planKey).toBe("family");
  });
});

describe("Stripe client", () => {
  it("form-encodes nested params the way Stripe expects", () => {
    expect(encodeForm({ mode: "subscription", line_items: [{ price: "p_1", quantity: 1 }], metadata: { userId: "u" }, skip: undefined }))
      .toBe("mode=subscription&line_items%5B0%5D%5Bprice%5D=p_1&line_items%5B0%5D%5Bquantity%5D=1&metadata%5BuserId%5D=u");
  });
  it("sends the key only in the Authorization header and hides it from errors", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 400, json: async () => ({ error: { message: "No such price", type: "invalid_request_error" } }) }));
    const c = stripeClient({ STRIPE_SECRET_KEY: "sk_test_secret", STRIPE_API_BASE: "http://mock" }, fetchImpl);
    const err = await c.request("POST", "/v1/checkout/sessions", { a: 1 }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String((err as Error).message)).not.toContain("sk_test_secret");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, { headers: Record<string, string>; body: string }];
    expect(url).toBe("http://mock/v1/checkout/sessions");
    expect(init.headers.Authorization).toBe("Bearer sk_test_secret");
    expect(init.body).toBe("a=1");
  });
});

describe("checkout", () => {
  const viewer = { id: USER, householdId: "h", name: "Anna", email: "anna@example.com", role: "owner" } as never;
  const req = () => {
    const calls: { method: string; path: string; params?: Record<string, unknown> }[] = [];
    const client: StripeClient = {
      request: vi.fn(async (method: string, path: string, params?: Record<string, unknown>) => {
        calls.push({ method, path, params });
        return (path === "/v1/customers" ? { id: "cus_new" } : { url: "https://checkout.stripe.com/c/pay/cs_test" }) as never;
      }) as StripeClient["request"],
    };
    return { client, calls };
  };

  beforeEach(() => {
    dbState.ownPlan = null;
    for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
  });

  it("opens Stripe Checkout for a public plan, with the price from the environment", async () => {
    const { startCheckout } = await import("./index");
    const { client, calls } = req();
    const out = await startCheckout(viewer, { plan: "family", interval: "year", baseUrl: "https://app.test", locale: "da" }, client);
    expect(out.url).toContain("checkout.stripe.com");
    const session = calls.find((c) => c.path === "/v1/checkout/sessions")!;
    expect(session.params).toMatchObject({ mode: "subscription", line_items: [{ price: "price_family_y", quantity: 1 }], client_reference_id: USER, locale: "da" });
    expect(JSON.stringify(calls)).not.toContain("ultimate");
  });

  it("never sells Ultimate or an add-on, even with a price set for it", async () => {
    const { startCheckout } = await import("./index");
    for (const plan of ["ultimate", "practice_psychology", "insights", "free"]) {
      const { client, calls } = req();
      await expect(startCheckout(viewer, { plan, interval: "month", baseUrl: "https://app.test", locale: "en" }, client)).rejects.toMatchObject({ status: 400 });
      expect(calls).toHaveLength(0);
    }
  });

  it("offers nothing to buy to a person on Ultimate", async () => {
    const { startCheckout, billingSummary } = await import("./index");
    dbState.ownPlan = "ultimate";
    const s = await billingSummary(viewer);
    expect(s.managedElsewhere).toBe(true);
    expect(s.canBuy).toEqual([]);
    const { client, calls } = req();
    await expect(startCheckout(viewer, { plan: "family", interval: "month", baseUrl: "https://app.test", locale: "en" }, client)).rejects.toMatchObject({ status: 409 });
    expect(calls).toHaveLength(0);
  });

  it("offers nothing and refuses checkout without Stripe set up", async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    const { startCheckout, billingSummary } = await import("./index");
    const s = await billingSummary(viewer);
    expect(s.configured).toBe(false);
    expect(s.canBuy).toEqual([]);
    const { client, calls } = req();
    await expect(startCheckout(viewer, { plan: "plus", interval: "month", baseUrl: "https://app.test", locale: "en" }, client)).rejects.toMatchObject({ status: 503 });
    expect(calls).toHaveLength(0);
  });

  it("lists only sellable plans as buyable for a child: none", async () => {
    const { billingSummary } = await import("./index");
    expect((await billingSummary({ id: USER, role: "child" })).canBuy).toEqual([]);
    expect((await billingSummary({ id: USER, role: "parent" })).canBuy).toEqual(["plus"]);
    expect((await billingSummary({ id: USER, role: "owner" })).canBuy).toEqual(["plus", "family"]);
  });
});
