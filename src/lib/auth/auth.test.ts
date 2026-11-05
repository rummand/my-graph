import { describe, expect, it } from "vitest";
import { auditActionLabel, auditDetail, auditIsWarning } from "./audit-labels";
import { isPublicPath, sessionCookieOptions } from "./constants";
import { canManageRole, personKindFor, personVisibilityFor } from "./members";
import { hashPassword, passwordProblem, verifyPassword } from "./passwords";
import { accountKey, AttemptLimiter, attemptKey, clientIp } from "./rate-limit";
import { createMemberBody, loginBody, setupBody, updateMemberBody } from "./schemas";
import {
  describeUserAgent, hashToken, isWellFormedToken, needsDeviceApproval, newToken, safeNext, SESSION_TTL_MS, sessionExpiry, shouldTouch,
} from "./session";
import { signInBlocked } from "./store";
import { expectedOrigins, relyingParty } from "./webauthn";

describe("session tokens", () => {
  it("are 32 random bytes, base64url, and hashed with sha256", () => {
    const t = newToken();
    expect(isWellFormedToken(t)).toBe(true);
    expect(Buffer.from(t, "base64url")).toHaveLength(32);
    expect(newToken()).not.toBe(t);
    expect(hashToken(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(t)).toBe(hashToken(t));
  });
  it("rejects malformed cookies before the database", () => {
    expect(isWellFormedToken("")).toBe(false);
    expect(isWellFormedToken(undefined)).toBe(false);
    expect(isWellFormedToken("x".repeat(42))).toBe(false);
    expect(isWellFormedToken("a".repeat(42) + "!")).toBe(false);
  });
  it("expires in 30 days and slides at most hourly", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    expect(sessionExpiry(now).getTime() - now.getTime()).toBe(SESSION_TTL_MS);
    expect(shouldTouch(new Date(now.getTime() - 30 * 60_000), now)).toBe(false);
    expect(shouldTouch(new Date(now.getTime() - 61 * 60_000), now)).toBe(true);
  });
  it("uses httpOnly, lax, and secure cookies in production", () => {
    expect(sessionCookieOptions({ NODE_ENV: "production" })).toMatchObject({ httpOnly: true, sameSite: "lax", secure: true, path: "/" });
    expect(sessionCookieOptions({ NODE_ENV: "development" }).secure).toBe(false);
    expect(sessionCookieOptions({ NODE_ENV: "production", APP_URL: "http://localhost:3000" }).secure).toBe(false);
  });
});

describe("safeNext", () => {
  it("only allows same-site relative paths", () => {
    expect(safeNext("/people/1?x=2")).toBe("/people/1?x=2");
    expect(safeNext("https://evil.example")).toBe("/");
    expect(safeNext("//evil.example")).toBe("/");
    expect(safeNext("/\\evil.example")).toBe("/");
    expect(safeNext("/login")).toBe("/");
    expect(safeNext(undefined)).toBe("/");
  });
});

describe("public paths", () => {
  it("lets login, setup, api and assets through", () => {
    for (const p of ["/login", "/login/pending", "/setup", "/api/auth/login", "/_next/static/x.js", "/manifest.webmanifest", "/logo.png"]) {
      expect(isPublicPath(p)).toBe(true);
    }
    for (const p of ["/", "/settings", "/people/abc", "/loginx", "/library"]) expect(isPublicPath(p)).toBe(false);
  });
});

describe("AttemptLimiter", () => {
  it("allows 5 failures per 15 minutes per key, then reports when to retry", () => {
    let now = 0;
    const l = new AttemptLimiter(5, 15 * 60_000, () => now);
    const k = attemptKey("1.2.3.4", " Anna@Example.com ");
    expect(k).toBe("1.2.3.4|anna@example.com");
    for (let i = 0; i < 5; i++) { expect(l.check(k).allowed).toBe(true); l.fail(k); }
    const blocked = l.check(k);
    expect(blocked.allowed).toBe(false);
    if (!blocked.allowed) expect(blocked.retryAfterSec).toBe(900);
    expect(l.check(attemptKey("1.2.3.4", "other")).allowed).toBe(true);
    now = 15 * 60_000 + 1;
    expect(l.check(k).allowed).toBe(true);
  });
  it("clears on success", () => {
    const l = new AttemptLimiter(2, 1000, () => 0);
    l.fail("k"); l.fail("k");
    expect(l.check("k").allowed).toBe(false);
    l.reset("k");
    expect(l.check("k").allowed).toBe(true);
  });
  it("reads the client IP from proxy headers", () => {
    const h = (o: Record<string, string>) => ({ get: (n: string) => o[n] ?? null });
    expect(clientIp(h({ "x-forwarded-for": "9.9.9.9, 10.0.0.1" }))).toBe("9.9.9.9");
    expect(clientIp(h({ "x-real-ip": "8.8.8.8" }))).toBe("8.8.8.8");
    expect(clientIp(h({}))).toBe("unknown");
  });
});

describe("account limiter", () => {
  it("keys by account only, so a rotated X-Forwarded-For doesn't reset it", () => {
    const l = new AttemptLimiter(3, 60_000, () => 1000);
    for (const ip of ["1.1.1.1", "2.2.2.2", "3.3.3.3"]) {
      expect(attemptKey(ip, "Anna@x.dk")).not.toBe(accountKey("anna@x.dk"));
      l.fail(accountKey(" Anna@x.dk "));
    }
    expect(l.check(accountKey("anna@x.dk")).allowed).toBe(false);
  });
});

describe("passwords", () => {
  it("checks the rules", () => {
    expect(passwordProblem("short")).toMatch(/10 characters/);
    expect(passwordProblem("aaaaaaaaaaaa")).toMatch(/repeated/);
    expect(passwordProblem("anna@example.com", { email: "anna@example.com" })).toMatch(/email/);
    expect(passwordProblem("x".repeat(40) + "é".repeat(20))).toMatch(/too long/);
    expect(passwordProblem("demo-demo-demo")).toBeNull();
  });
  it("hashes with bcrypt cost 12 and verifies", async () => {
    const h = await hashPassword("correct horse battery");
    expect(h).toMatch(/^\$2[aby]\$12\$/);
    expect(await verifyPassword("correct horse battery", h)).toBe(true);
    expect(await verifyPassword("wrong horse battery", h)).toBe(false);
    expect(await verifyPassword("anything at all", null)).toBe(false);
  }, 20_000);
});

describe("schemas", () => {
  it("accepts emails and simple usernames, lowercased", () => {
    expect(loginBody.parse({ email: " Anna@Example.com ", password: "x" }).email).toBe("anna@example.com");
    expect(loginBody.parse({ email: "Emma", password: "x" }).email).toBe("emma");
    expect(loginBody.safeParse({ email: "a b", password: "x" }).success).toBe(false);
  });
  it("setup needs a real email and a good password", () => {
    expect(setupBody.safeParse({ householdName: "Home", name: "Anna", email: "anna", password: "demo-demo-demo" }).success).toBe(false);
    expect(setupBody.safeParse({ householdName: "Home", name: "Anna", email: "anna@x.dk", password: "short" }).success).toBe(false);
    expect(setupBody.safeParse({ householdName: "Home", name: "Anna", email: "anna@x.dk", password: "demo-demo-demo" }).success).toBe(true);
  });
  it("children need a birth year, guests a future end date", () => {
    const base = { name: "X", email: "xx-user", password: "demo-demo-demo" };
    expect(createMemberBody.safeParse({ ...base, role: "child" }).success).toBe(false);
    expect(createMemberBody.safeParse({ ...base, role: "child", birthYear: 2016 }).success).toBe(true);
    expect(createMemberBody.safeParse({ ...base, role: "child", birthYear: 1950 }).success).toBe(false);
    expect(createMemberBody.safeParse({ ...base, role: "guest" }).success).toBe(false);
    expect(createMemberBody.safeParse({ ...base, role: "guest", accessExpiresAt: "2001-01-01" }).success).toBe(false);
    expect(createMemberBody.safeParse({ ...base, role: "guest", accessExpiresAt: new Date(Date.now() + 86_400_000).toISOString() }).success).toBe(true);
    expect(createMemberBody.safeParse({ ...base, role: "owner" }).success).toBe(false);
  });
  it("member updates must change something", () => {
    expect(updateMemberBody.safeParse({}).success).toBe(false);
    expect(updateMemberBody.safeParse({ disableSignIn: true }).success).toBe(true);
  });
});

describe("roles", () => {
  it("owners manage everyone but the owner; parents manage children and guests", () => {
    expect(canManageRole("owner", "parent")).toBe(true);
    expect(canManageRole("owner", "owner")).toBe(false);
    expect(canManageRole("parent", "parent")).toBe(false);
    expect(canManageRole("parent", "child")).toBe(true);
    expect(canManageRole("parent", "guest")).toBe(true);
    expect(canManageRole("child", "child")).toBe(false);
    expect(canManageRole("guest", "guest")).toBe(false);
  });
  it("children and guests need device approval", () => {
    expect(needsDeviceApproval("child")).toBe(true);
    expect(needsDeviceApproval("guest")).toBe(true);
    expect(needsDeviceApproval("parent")).toBe(false);
    expect(needsDeviceApproval("owner")).toBe(false);
  });
  it("member person nodes: children get the child kind; guests stay private", () => {
    expect(personKindFor("child")).toBe("child");
    expect(personKindFor("parent")).toBeNull();
    expect(personVisibilityFor("guest")).toBe("private");
    expect(personVisibilityFor("child")).toBe("household");
  });
  it("guests whose access ended can't sign in", () => {
    const now = new Date("2026-06-01T00:00:00Z");
    expect(signInBlocked({ role: "guest", accessExpiresAt: new Date("2026-05-31T00:00:00Z") }, now)).toMatch(/ended/);
    expect(signInBlocked({ role: "guest", accessExpiresAt: null }, now)).toMatch(/ended/);
    expect(signInBlocked({ role: "guest", accessExpiresAt: new Date("2026-06-02T00:00:00Z") }, now)).toBeNull();
    expect(signInBlocked({ role: "child", accessExpiresAt: null }, now)).toBeNull();
  });
});

describe("webauthn config", () => {
  it("derives the relying party from env", () => {
    expect(relyingParty({})).toEqual({ rpID: "localhost", rpName: "My Graph", origins: ["http://localhost:3000"] });
    expect(relyingParty({ APP_URL: "https://mygraph.eu/" })).toMatchObject({ rpID: "mygraph.eu", origins: ["https://mygraph.eu"] });
    expect(relyingParty({ WEBAUTHN_RP_ID: "a.dk", WEBAUTHN_ORIGIN: "https://a.dk" }).rpID).toBe("a.dk");
  });
  it("accepts other local ports only in development", () => {
    expect(expectedOrigins("http://localhost:3101", { NODE_ENV: "development" })).toContain("http://localhost:3101");
    expect(expectedOrigins("http://localhost:3101", { NODE_ENV: "production" })).not.toContain("http://localhost:3101");
    expect(expectedOrigins("http://evil.example", { NODE_ENV: "development" })).not.toContain("http://evil.example");
  });
});

describe("audit wording", () => {
  it("labels known and unknown actions", () => {
    expect(auditActionLabel("auth.login")).toBe("Signed in");
    expect(auditActionLabel("wiki.page_delete")).toBe("Page delete (pages)");
    expect(auditIsWarning("auth.login_failed")).toBe(true);
    expect(auditIsWarning("auth.login")).toBe(false);
  });
  it("builds a detail line without hashes", () => {
    expect(auditDetail({ name: "Emma", role: "child", deviceHash: "abc", method: "passkey", ip: "1.2.3.4" }))
      .toBe("Emma · child · with a passkey · from 1.2.3.4");
  });
});

describe("user agents", () => {
  it("names common devices", () => {
    expect(describeUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1")).toBe("Safari on iPhone");
    expect(describeUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0 Safari/537.36")).toBe("Chrome on Mac");
    expect(describeUserAgent(null)).toBe("Unknown device");
  });
});
