import { beforeEach, describe, expect, it, vi } from "vitest";

const inserted: Record<string, unknown>[] = [];
vi.mock("@/db", () => ({ db: { insert: () => ({ values: async (v: Record<string, unknown>) => { inserted.push(v); } }) } }));
vi.mock("@/lib/auth", () => ({ getViewer: async () => null, requireUser: async () => null }));

const admin = { id: "admin-1", householdId: "hh-admin", email: "rummand@gmail.com", name: "Jesper" };
const target = { id: "11111111-1111-4111-8111-111111111111", householdId: "hh-2", email: "mikkel@example.com", name: "Mikkel" };
const calls: string[] = [];

vi.mock("@/lib/auth/signin", () => ({ findUserById: async (id: string) => (id === target.id ? target : null) }));
vi.mock("@/lib/auth/account-controls", () => ({
  issueResetToken: async () => { calls.push("reset"); return { token: "tok", expiresAt: new Date("2026-11-05T10:00:00Z") }; },
  setLocked: async (_id: string, locked: boolean) => { calls.push(locked ? "lock" : "unlock"); return { signedOut: locked ? 2 : 0 }; },
  setTemporaryPassword: async () => { calls.push("temp"); return { password: "abcd-efgh-jkmn", signedOut: 1 }; },
  signOutEverywhere: async () => { calls.push("signout"); return 3; },
}));
vi.mock("@/lib/plans/store", async (orig) => ({
  ...(await orig<typeof import("./store")>()),
  setAccountPlan: async () => { calls.push("plan"); return { from: "free" }; },
  setAccountAddon: async () => { calls.push("addon"); },
}));
vi.mock("@/lib/plans/admin", async (orig) => ({
  ...(await orig<typeof import("./admin")>()),
  requirePlatformAdminApi: async () => admin,
}));

import { POST } from "@/app/api/admin/accounts/[id]/route";
import { auditAdmin } from "./admin";

const post = (body: unknown) => POST(
  new Request(`http://localhost:3917/api/admin/accounts/${target.id}`, { method: "POST", body: JSON.stringify(body), headers: { host: "localhost:3917" } }),
  { params: Promise.resolve({ id: target.id }) },
);

describe("admin audit", () => {
  beforeEach(() => { inserted.length = 0; calls.length = 0; });

  it("files every admin action under the admin, with their id", async () => {
    await auditAdmin(admin, "admin.lock", { type: "user", id: target.id }, { reason: "asked" });
    expect(inserted).toEqual([expect.objectContaining({
      householdId: "hh-admin", userId: "admin-1", action: "admin.lock", targetType: "user", targetId: target.id,
      meta: expect.objectContaining({ adminId: "admin-1", adminEmail: "rummand@gmail.com", reason: "asked" }),
    })]);
  });

  it.each([
    [{ action: "set_plan", plan: "ultimate" }, "admin.plan_change", "plan"],
    [{ action: "set_addon", addon: "practice_psychology", enabled: true }, "admin.addon_grant", "addon"],
    [{ action: "set_addon", addon: "insights", enabled: false }, "admin.addon_revoke", "addon"],
    [{ action: "lock", reason: "paused" }, "admin.lock", "lock"],
    [{ action: "unlock" }, "admin.unlock", "unlock"],
    [{ action: "sign_out" }, "admin.sign_out_all", "signout"],
    [{ action: "reset_link" }, "admin.reset_link", "reset"],
    [{ action: "temp_password" }, "admin.temp_password", "temp"],
  ])("%o is done and written to the audit log", async (body, action, call) => {
    const res = await post(body);
    expect(res.status).toBe(200);
    expect(calls).toEqual([call]);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ userId: "admin-1", action, targetId: target.id, meta: expect.objectContaining({ adminId: "admin-1" }) });
  });

  it("hands back a one-time reset link to copy, never stored in the log", async () => {
    const res = await post({ action: "reset_link" });
    const json = await res.json() as { url: string };
    expect(json.url).toBe("http://localhost:3917/login/reset/tok");
    expect(JSON.stringify(inserted)).not.toContain("tok\"");
  });

  it("refuses bad input with a JSON error and logs nothing", async () => {
    const res = await post({ action: "set_addon", addon: "made_up", enabled: true });
    expect(res.status).toBe(400);
    expect(await res.json()).toHaveProperty("error");
    expect(inserted).toHaveLength(0);
  });

  it("won't lock a platform admin", async () => {
    const res = await POST(
      new Request(`http://localhost:3917/api/admin/accounts/${target.id}`, { method: "POST", body: JSON.stringify({ action: "lock" }) }),
      { params: Promise.resolve({ id: target.id }) },
    );
    expect(res.status).toBe(200); // target is an ordinary account
    target.email = "rummand@gmail.com";
    const refused = await post({ action: "lock" });
    target.email = "mikkel@example.com";
    expect(refused.status).toBe(409);
  });
});
