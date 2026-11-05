import { describe, expect, it } from "vitest";
import { hashKey, judge, memoryCountStore, RateLimiter, type CountStore } from "./rate-limit";
import { memoryOnceStore, OneTimeTokens, type OnceStore } from "./once";
import { SharedAttemptLimiter } from "./limits";

const L = { bucket: "test", limit: 3, windowMs: 60_000 };
const quiet = () => {};

function clock(start = 1_800_000_000_000) {
  let t = start;
  return { now: () => t, tick: (ms: number) => { t += ms; } };
}

/** A store that fails every call, like a database that has gone away. */
const down: CountStore = {
  add: async () => { throw new Error("ECONNREFUSED"); },
  read: async () => { throw new Error("ECONNREFUSED"); },
  clear: async () => { throw new Error("ECONNREFUSED"); },
  sweep: async () => { throw new Error("ECONNREFUSED"); },
};

describe("the sliding estimate", () => {
  it("allows up to the limit and says how long to wait past it", () => {
    expect(judge(L, 0, 3, 0)).toEqual({ allowed: true, remaining: 0 });
    const v = judge(L, 0, 4, 0);
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.retryAfterSec).toBeGreaterThanOrEqual(60);
  });

  it("counts the part of the last window that still overlaps", () => {
    // 15 seconds into a window: 75% of the previous window still counts.
    const at = 60_000 * 10 + 15_000;
    expect(judge(L, at, 1, 2).allowed).toBe(true); // 1 + 1.5 = 2.5
    const v = judge(L, at, 2, 2); // 2 + 1.5 = 3.5
    expect(v.allowed).toBe(false);
    // back under when 2 + 2 × (1 − f) ≤ 3 → f ≥ 0.5 → 30 s into the window, 15 s from now
    if (!v.allowed) expect(v.retryAfterSec).toBe(15);
  });
});

describe("the shared limiter", () => {
  it("is shared: two server processes (two limiters on one store) count together", async () => {
    const c = clock();
    const store = memoryCountStore();
    const a = new RateLimiter({ store, now: c.now, onStoreError: quiet });
    const b = new RateLimiter({ store, now: c.now, onStoreError: quiet });
    expect((await a.hit(L, "k")).allowed).toBe(true);
    expect((await b.hit(L, "k")).allowed).toBe(true);
    expect((await a.hit(L, "k")).allowed).toBe(true);
    expect((await b.hit(L, "k")).allowed).toBe(false);
    // A restart (a new limiter, an empty cache) still refuses: the count is in the store.
    const restarted = new RateLimiter({ store, now: c.now, onStoreError: quiet });
    expect((await restarted.hit(L, "k")).allowed).toBe(false);
    // Another key is unaffected.
    expect((await restarted.hit(L, "other")).allowed).toBe(true);
  });

  it("lets requests through again once the window has passed", async () => {
    const c = clock(60_000 * 1000);
    const l = new RateLimiter({ store: memoryCountStore(), now: c.now, onStoreError: quiet });
    for (let i = 0; i < 3; i++) await l.hit(L, "k");
    expect((await l.hit(L, "k")).allowed).toBe(false);
    c.tick(2 * 60_000);
    expect((await l.hit(L, "k")).allowed).toBe(true);
  });

  it("answers from its cache once a key is over, without asking the store again", async () => {
    const c = clock(60_000 * 1000);
    const inner = memoryCountStore();
    let calls = 0;
    const counting: CountStore = {
      add: (...a) => { calls++; return inner.add(...a); }, read: (...a) => { calls++; return inner.read(...a); },
      clear: (...a) => inner.clear(...a), sweep: (...a) => inner.sweep(...a),
    };
    const l = new RateLimiter({ store: counting, now: c.now, onStoreError: quiet });
    for (let i = 0; i < 4; i++) await l.hit(L, "k");
    const before = calls;
    for (let i = 0; i < 50; i++) expect((await l.hit(L, "k")).allowed).toBe(false);
    expect(calls).toBe(before);
  });

  it("keeps limiting in memory when the database is down", async () => {
    const c = clock();
    let errors = 0;
    const l = new RateLimiter({ store: down, now: c.now, onStoreError: () => { errors++; } });
    for (let i = 0; i < 3; i++) expect((await l.hit(L, "k")).allowed).toBe(true);
    expect((await l.hit(L, "k")).allowed).toBe(false);
    expect(errors).toBeGreaterThan(0);
  });

  it("stores keys hashed, never as given", async () => {
    const store = memoryCountStore();
    const seen: string[] = [];
    const spy: CountStore = { ...store, add: (b, k, ...r) => { seen.push(k); return store.add(b, k, ...r); } };
    await new RateLimiter({ store: spy, onStoreError: quiet }).hit(L, "anna@example.com|10.0.0.1");
    expect(seen[0]).toBe(hashKey("anna@example.com|10.0.0.1"));
    expect(seen[0]).not.toContain("anna");
  });

  it("works as the sign-in limiter: check, count failures, clear on success", async () => {
    const c = clock();
    const l = new RateLimiter({ store: memoryCountStore(), now: c.now, onStoreError: quiet });
    const logins = new SharedAttemptLimiter("loginIp", () => l); // 5 failures per 15 minutes
    for (let i = 0; i < 5; i++) {
      expect((await logins.check("ip|anna")).allowed).toBe(true);
      await logins.fail("ip|anna");
    }
    const no = await logins.check("ip|anna");
    expect(no.allowed).toBe(false);
    if (!no.allowed) expect(no.retryAfterSec).toBeGreaterThan(60);
    await logins.reset("ip|anna");
    expect((await logins.check("ip|anna")).allowed).toBe(true);
  });
});

describe("one-time tokens", () => {
  it("are used once across processes and restarts", async () => {
    const shared = memoryOnceStore();
    const a = new OneTimeTokens(shared, quiet), b = new OneTimeTokens(shared, quiet);
    const exp = Date.now() + 60_000;
    expect(await a.spend("x", "tok", exp)).toBe(true);
    expect(await a.spend("x", "tok", exp)).toBe(false);
    expect(await b.spend("x", "tok", exp)).toBe(false);
    expect(await b.spend("y", "tok", exp)).toBe(true); // another kind is another token
  });

  it("are forgotten once they would have expired anyway", async () => {
    const shared = memoryOnceStore();
    await shared.claim("h", "x", null, 1000);
    await shared.sweep(2000);
    expect(shared.size()).toBe(0);
  });

  it("still refuse a second use in this process when the database is down", async () => {
    const broken: OnceStore = { claim: async () => { throw new Error("down"); }, sweep: async () => {} };
    const t = new OneTimeTokens(broken, quiet);
    expect(await t.spend("x", "tok", Date.now() + 1000)).toBe(true);
    expect(await t.spend("x", "tok", Date.now() + 1000)).toBe(false);
  });
});
