import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const entitlements = vi.fn();
vi.mock("./store", () => ({ loadEntitlements: (...a: unknown[]) => entitlements(...a) }));

import {
  ADDON_KEYS, PLAN_CATALOG, ULTIMATE, canGrantAddon, effectivePlan, emailIsAdmin, parseAdminEmails, resolveFeatures,
  visibleAddons, visiblePlans,
} from "./catalog";
import { adminGate } from "./admin-guard";
import { hasFeature, isPlatformAdmin, plansEnforced } from "./index";
import { AttemptLimiter } from "@/lib/auth/rate-limit";
import type { Viewer } from "@/lib/auth";

const viewer = (email: string): Viewer => ({
  id: "u1", householdId: "h1", name: "Anna", email, role: "owner", personNodeId: null,
  graphId: "g1", graphRole: "owner", graphKind: "family", isFamilyGraph: true,
} as unknown as Viewer);

describe("feature resolution", () => {
  const ultimateFeatures = PLAN_CATALOG.find((p) => p.key === ULTIMATE)!.features;

  it("gives a plan its own features and nothing else", () => {
    const f = resolveFeatures({ planKey: "free", planFeatures: ["assistant", "library"], addons: [], isAdmin: false });
    expect([...f].sort()).toEqual(["assistant", "library"]);
  });
  it("counts Ultimate's add-ons only on the person's own Ultimate", () => {
    const own = resolveFeatures({ planKey: ULTIMATE, planFeatures: ultimateFeatures, addons: ["practice_psychology"], isAdmin: false });
    expect(own.has("practice_psychology")).toBe(true);
    expect(own.has("practice_medical")).toBe(false);
    const inherited = resolveFeatures({ planKey: ULTIMATE, inherited: true, planFeatures: ultimateFeatures, addons: ["practice_psychology"], isAdmin: false });
    expect(inherited.has("practice_psychology")).toBe(false);
    expect(inherited.has("priority_support")).toBe(true);
  });
  it("ignores add-ons left on an account that moved off Ultimate, and unknown add-ons", () => {
    const f = resolveFeatures({ planKey: "family", planFeatures: ["assistant"], addons: ["insights", "made_up"], isAdmin: false });
    expect(f.has("insights")).toBe(false);
    expect(f.has("made_up")).toBe(false);
  });
  it("gives the platform admin every add-on and the console; never the console to anyone else", () => {
    const admin = resolveFeatures({ planKey: ULTIMATE, planFeatures: ultimateFeatures, addons: [], isAdmin: true });
    for (const a of ADDON_KEYS) expect(admin.has(a)).toBe(true);
    expect(admin.has("admin_console")).toBe(true);
    const sneaky = resolveFeatures({ planKey: "plus", planFeatures: ["admin_console"], addons: [], isAdmin: false });
    expect(sneaky.has("admin_console")).toBe(false);
  });
  it("uses the person's own plan, else the household owner's, else Free", () => {
    expect(effectivePlan("plus", "family")).toEqual({ key: "plus", inherited: false });
    expect(effectivePlan(null, "family")).toEqual({ key: "family", inherited: true });
    expect(effectivePlan(null, null)).toEqual({ key: "free", inherited: false });
    // Ultimate never passes to the household, not even its name.
    expect(effectivePlan(null, ULTIMATE)).toEqual({ key: "family", inherited: true });
  });
  it("only grants add-ons on Ultimate", () => {
    expect(canGrantAddon(ULTIMATE, "practice_medical")).toBe(true);
    expect(canGrantAddon("family", "practice_medical")).toBe(false);
    expect(canGrantAddon(ULTIMATE, "nope")).toBe(false);
  });
});

describe("hidden plans", () => {
  const rows = PLAN_CATALOG.map(({ key, name, public: p, sort }) => ({ key, name, public: p, sort }));
  it("never offers Ultimate to anyone but the platform admin", () => {
    expect(visiblePlans(rows, { isAdmin: false }).map((p) => p.key)).toEqual(["free", "plus", "family"]);
    expect(visiblePlans(rows, { isAdmin: true }).map((p) => p.key)).toEqual(["free", "plus", "family", ULTIMATE]);
  });
  it("shows a person only the add-ons they have; the admin sees them all", () => {
    expect(visibleAddons([], { isAdmin: false })).toEqual([]);
    expect(visibleAddons(["insights"], { isAdmin: false })).toEqual(["insights"]);
    expect(visibleAddons([], { isAdmin: true })).toEqual(ADDON_KEYS);
  });
  it("seeds Ultimate as hidden and the rest as public", () => {
    expect(PLAN_CATALOG.find((p) => p.key === ULTIMATE)?.public).toBe(false);
    expect(PLAN_CATALOG.filter((p) => p.public).map((p) => p.key)).toEqual(["free", "plus", "family"]);
  });
});

describe("platform admins", () => {
  it("reads PLATFORM_ADMIN_EMAILS, defaulting to the founder, case-insensitively", () => {
    expect(parseAdminEmails(undefined)).toEqual(["rummand@gmail.com"]);
    expect(parseAdminEmails(" A@x.dk, b@y.dk ,")).toEqual(["a@x.dk", "b@y.dk"]);
    expect(emailIsAdmin("Rummand@Gmail.com", parseAdminEmails(undefined))).toBe(true);
    expect(emailIsAdmin("anna@example.com", parseAdminEmails(undefined))).toBe(false);
    expect(emailIsAdmin("", ["" as string])).toBe(false);
  });
});

describe("hasFeature", () => {
  const env = { ...process.env };
  beforeEach(() => { entitlements.mockReset(); });
  afterEach(() => { process.env = { ...env }; });

  it("keeps the admin console to platform admins even in development", async () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(await hasFeature(viewer("anna@example.com"), "admin_console")).toBe(false);
    expect(await hasFeature(viewer("rummand@gmail.com"), "admin_console")).toBe(true);
    expect(isPlatformAdmin({ email: "RUMMAND@gmail.com" })).toBe(true);
    vi.unstubAllEnvs();
  });
  it("is open in development unless PLANS_ENFORCE=1", async () => {
    expect(plansEnforced({ NODE_ENV: "development" })).toBe(false);
    expect(plansEnforced({ NODE_ENV: "development", PLANS_ENFORCE: "1" })).toBe(true);
    expect(plansEnforced({ NODE_ENV: "production" })).toBe(true);
  });
  it("resolves from the account's plan when enforced", async () => {
    vi.stubEnv("PLANS_ENFORCE", "1");
    entitlements.mockResolvedValue({ features: new Set(["assistant", "insights"]) });
    const v = { ...viewer("sara@example.com"), id: "u-sara" };
    expect(await hasFeature(v, "insights")).toBe(true);
    expect(await hasFeature(v, "practice_medical")).toBe(false);
    vi.unstubAllEnvs();
  });
  it("fails closed when the plan can't be read", async () => {
    vi.stubEnv("PLANS_ENFORCE", "1");
    entitlements.mockRejectedValue(new Error("relation does not exist"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const v = { ...viewer("mikkel@example.com"), id: "u-mikkel" };
    expect(await hasFeature(v, "insights")).toBe(false);
    vi.unstubAllEnvs();
  });
});

describe("admin guard", () => {
  const sameSite = { origin: "http://localhost:3917", secFetchSite: "same-origin", host: "localhost:3917", forwardedHost: null };
  const admins = ["rummand@gmail.com"];
  const admin = { id: "a1", email: "rummand@gmail.com" };

  it("answers 404 to everyone who isn't a platform admin, signed in or not", () => {
    const limiter = new AttemptLimiter(60, 60_000);
    expect(adminGate({ viewer: null, admins, method: "GET", origin: sameSite, limiter })).toMatchObject({ ok: false, status: 404 });
    expect(adminGate({ viewer: { id: "u", email: "anna@example.com" }, admins, method: "POST", origin: sameSite, limiter }))
      .toMatchObject({ ok: false, status: 404 });
    expect(adminGate({ viewer: admin, admins, method: "GET", origin: sameSite, limiter })).toEqual({ ok: true });
  });
  it("refuses changes from another site", () => {
    const limiter = new AttemptLimiter(60, 60_000);
    const evil = { origin: "https://evil.example", secFetchSite: "cross-site", host: "localhost:3917", forwardedHost: null };
    expect(adminGate({ viewer: admin, admins, method: "POST", origin: evil, limiter })).toMatchObject({ ok: false, status: 403 });
    expect(adminGate({ viewer: admin, admins, method: "POST", origin: sameSite, limiter })).toEqual({ ok: true });
  });
  it("rate-limits each admin", () => {
    let now = 0;
    const limiter = new AttemptLimiter(3, 60_000, () => now);
    for (let i = 0; i < 3; i++) expect(adminGate({ viewer: admin, admins, method: "POST", origin: sameSite, limiter }).ok).toBe(true);
    expect(adminGate({ viewer: admin, admins, method: "POST", origin: sameSite, limiter })).toMatchObject({ ok: false, status: 429 });
    now = 61_000;
    expect(adminGate({ viewer: admin, admins, method: "POST", origin: sameSite, limiter }).ok).toBe(true);
  });
});
