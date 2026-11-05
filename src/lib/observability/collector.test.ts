import { describe, expect, it } from "vitest";
import { MINUTE_MS, OTHER_ROUTE, TimingCollector, normalizeMethod, normalizeRoute } from "./collector";
import { BOUNDS_MS, BUCKETS, addHist, bucketOf, emptyHist, quantileOf } from "./histogram";

const T0 = Date.UTC(2026, 10, 4, 12, 0, 0);

describe("histogram", () => {
  it("puts durations in the first bucket whose bound holds them", () => {
    expect(bucketOf(0)).toBe(0);
    expect(bucketOf(10)).toBe(0);
    expect(bucketOf(11)).toBe(1);
    expect(bucketOf(400)).toBe(BOUNDS_MS.indexOf(400));
    expect(bucketOf(1e9)).toBe(BUCKETS - 1);
    expect(bucketOf(Number.NaN)).toBe(0);
  });

  it("estimates quantiles inside the bucket and caps at the max", () => {
    const h = emptyHist();
    for (let i = 0; i < 100; i++) h[bucketOf(i < 90 ? 40 : 900)] += 1;
    const p50 = quantileOf(h, 0.5, 950)!;
    const p95 = quantileOf(h, 0.95, 950)!;
    expect(p50).toBeGreaterThan(25);
    expect(p50).toBeLessThanOrEqual(50);
    expect(p95).toBeGreaterThan(800);
    expect(p95).toBeLessThanOrEqual(950);
    expect(quantileOf(emptyHist(), 0.5)).toBeNull();
  });

  it("uses the max for the open-ended bucket", () => {
    const h = emptyHist();
    h[BUCKETS - 1] = 3;
    expect(quantileOf(h, 0.95, 45_000)).toBeLessThanOrEqual(45_000);
    expect(quantileOf(h, 0.95, 45_000)).toBeGreaterThanOrEqual(30_000);
  });

  it("adds histograms element-wise", () => {
    expect(addHist([1, 2], [3]).slice(0, 3)).toEqual([4, 2, 0]);
    expect(addHist([], []).length).toBe(BUCKETS);
  });
});

describe("normalizeRoute", () => {
  it("keeps Next route patterns", () => {
    expect(normalizeRoute("/people/[id]")).toBe("/people/[id]");
    expect(normalizeRoute("/")).toBe("/");
    expect(normalizeRoute("/api/people/[id]/route")).toBe("/api/people/[id]");
  });
  it("turns concrete ids into [id] and drops query strings", () => {
    expect(normalizeRoute("/people/2227e904-28ed-4c5a-8941-acf4ae4da5ab?tab=notes#x")).toBe("/people/[id]");
    expect(normalizeRoute("/api/jobs/123/retry")).toBe("/api/jobs/[id]/retry");
    expect(normalizeRoute("/api/invites/AbCdEf1234567890xyz")).toBe("/api/invites/[id]");
    expect(normalizeRoute("/wiki/school-trip/")).toBe("/wiki/school-trip");
  });
  it("handles missing input", () => {
    expect(normalizeRoute(null)).toBe(OTHER_ROUTE);
    expect(normalizeRoute("x".repeat(500)).length).toBeLessThanOrEqual(200);
  });
  it("knows methods", () => {
    expect(normalizeMethod("get")).toBe("GET");
    expect(normalizeMethod("RSC")).toBe("RSC");
    expect(normalizeMethod("BREW")).toBe("OTHER");
  });
});

describe("TimingCollector", () => {
  it("groups samples by minute, route and method", () => {
    const c = new TimingCollector({ slowMs: 2000 });
    c.record({ route: "/people/[id]", method: "GET", ms: 120, status: 200, at: T0 + 1000 });
    c.record({ route: "/people/[id]", method: "GET", ms: 80, status: 200, at: T0 + 59_000 });
    c.record({ route: "/people/[id]", method: "RSC", ms: 30, status: 200, at: T0 + 2000 });
    c.record({ route: "/people/[id]", method: "GET", ms: 2500, status: 500, at: T0 + MINUTE_MS + 1 });
    expect(c.size).toBe(3);
    const rows = c.drain();
    expect(c.size).toBe(0);
    const first = rows.find((r) => r.method === "GET" && r.bucket.getTime() === T0)!;
    expect(first).toMatchObject({ route: "/people/[id]", count: 2, sumMs: 200, maxMs: 120, errors: 0, slow: 0 });
    expect(first.hist.reduce((a, b) => a + b, 0)).toBe(2);
    const later = rows.find((r) => r.bucket.getTime() === T0 + MINUTE_MS)!;
    expect(later).toMatchObject({ count: 1, errors: 1, slow: 1, maxMs: 2500 });
    expect(rows[0].bucket.getTime()).toBeLessThanOrEqual(rows[rows.length - 1].bucket.getTime());
  });

  it("normalizes concrete paths so ids never reach a row", () => {
    const c = new TimingCollector();
    c.record({ route: "/library/8879b007-4ff7-45d6-8cae-0aa50f8a505b", method: "GET", ms: 5, status: 200, at: T0 });
    expect(c.drain()[0].route).toBe("/library/[id]");
  });

  it("folds routes beyond the cap into (other)", () => {
    const c = new TimingCollector({ maxRoutes: 2 });
    for (const r of ["/a", "/b", "/c", "/d"]) c.record({ route: r, method: "GET", ms: 1, status: 200, at: T0 });
    const routes = c.drain().map((r) => r.route).sort();
    expect(routes).toEqual(["(other)", "/a", "/b"]);
    expect(new TimingCollector({ maxRoutes: 2 }).size).toBe(0);
  });

  it("ignores impossible durations", () => {
    const c = new TimingCollector();
    c.record({ route: "/", method: "GET", ms: -1, status: 200 });
    c.record({ route: "/", method: "GET", ms: Number.NaN, status: 200 });
    expect(c.size).toBe(0);
  });

  it("restores rows after a failed flush, merging with new samples", () => {
    const c = new TimingCollector();
    c.record({ route: "/", method: "GET", ms: 10, status: 200, at: T0 });
    const rows = c.drain();
    c.record({ route: "/", method: "GET", ms: 30, status: 200, at: T0 + 5 });
    c.restore(rows);
    const [r] = c.drain();
    expect(r).toMatchObject({ count: 2, sumMs: 40, maxMs: 30 });
    expect(r.hist.reduce((a, b) => a + b, 0)).toBe(2);
  });

  it("keeps memory bounded when the database stays away", () => {
    const c = new TimingCollector({ maxCells: 3 });
    const rows = [0, 1, 2, 3, 4].map((i) => ({
      bucket: new Date(T0 + i * MINUTE_MS), route: "/", method: "GET", count: 1, errors: 0, slow: 0, sumMs: 1, maxMs: 1, hist: emptyHist(),
    }));
    c.restore(rows);
    const kept = c.drain().map((r) => r.bucket.getTime());
    expect(kept).toEqual([T0 + 2 * MINUTE_MS, T0 + 3 * MINUTE_MS, T0 + 4 * MINUTE_MS]);
  });
});
