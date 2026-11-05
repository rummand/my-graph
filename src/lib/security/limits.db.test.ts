import { afterAll, describe, expect, it } from "vitest";
import { eq, like } from "drizzle-orm";
import { db, sql } from "@/db";
import { rateLimits, usedApprovals } from "@/db/schema";
import { dbCountStore, RateLimiter } from "./rate-limit";
import { dbOnceStore, OneTimeTokens } from "./once";

/**
 * Against the real database (opt-in: SECURITY_DB_TESTS=1 npx vitest run src/lib/security/limits.db.test.ts): the
 * counts are atomic under concurrency, shared by two limiters, and a used approval stays used.
 */
const enabled = !!process.env.SECURITY_DB_TESTS;
const bucket = `test.${Date.now()}`;

describe.skipIf(!enabled)("shared limits (database)", () => {
  afterAll(async () => {
    await db.delete(rateLimits).where(eq(rateLimits.bucket, bucket));
    await db.delete(usedApprovals).where(like(usedApprovals.kind, "test.%"));
    await sql.end({ timeout: 5 });
  });

  it("counts 50 concurrent requests from two processes exactly once each", async () => {
    const a = new RateLimiter({ store: dbCountStore }), b = new RateLimiter({ store: dbCountStore });
    const L = { bucket, limit: 30, windowMs: 3_600_000 };
    const out = await Promise.all(Array.from({ length: 50 }, (_, i) => (i % 2 ? a : b).hit(L, "k")));
    expect(out.filter((v) => v.allowed).length).toBe(30);
    const [row] = await db.select({ n: rateLimits.count }).from(rateLimits).where(eq(rateLimits.bucket, bucket));
    expect(row.n).toBe(50);
  });

  it("records an approval once, for every process", async () => {
    const exp = Date.now() + 60_000;
    const tok = `t${Date.now()}`;
    const [x, y] = [new OneTimeTokens(dbOnceStore), new OneTimeTokens(dbOnceStore)];
    const r = await Promise.all([x.spend("test.approval", tok, exp), y.spend("test.approval", tok, exp)]);
    expect(r.filter(Boolean).length).toBe(1);
  });
});
