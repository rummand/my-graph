import { describe, expect, it, vi } from "vitest";

const isLocked = vi.fn();
const createSession = vi.fn();
const writeAudit = vi.fn();
vi.mock("./account-controls", async (orig) => ({ ...(await orig<typeof import("./account-controls")>()), isLocked: (id: string) => isLocked(id) }));
vi.mock("./store", () => ({ createSession: (...a: unknown[]) => createSession(...a), pruneExpired: async () => {} }));
vi.mock("./audit", () => ({ writeAudit: (...a: unknown[]) => writeAudit(...a) }));

import {
  LOCKED_MESSAGE, RESET_TTL_MS, generateTemporaryPassword, lockedProblem, mustChangePassword, resetTokenState,
} from "./account-controls";
import { AuthError } from "./http";
import { passwordProblem } from "./passwords";
import { completeSignIn, type UserRow } from "./signin";

describe("reset links", () => {
  const made = new Date("2026-11-04T10:00:00Z");
  const row = { expiresAt: new Date(made.getTime() + RESET_TTL_MS), usedAt: null as Date | null };
  it("work for 24 hours", () => {
    expect(RESET_TTL_MS).toBe(24 * 60 * 60 * 1000);
    expect(resetTokenState(row, new Date(made.getTime() + RESET_TTL_MS - 1000))).toBe("ok");
    expect(resetTokenState(row, new Date(made.getTime() + RESET_TTL_MS))).toBe("expired");
  });
  it("work once", () => {
    expect(resetTokenState({ ...row, usedAt: made }, made)).toBe("used");
  });
  it("don't work when unknown", () => {
    expect(resetTokenState(null, made)).toBe("missing");
  });
});

describe("temporary passwords", () => {
  it("are strong enough to pass the password rules and differ every time", () => {
    const a = generateTemporaryPassword();
    expect(a).toMatch(/^[A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$/);
    expect(passwordProblem(a)).toBeNull();
    expect(generateTemporaryPassword()).not.toBe(a);
  });
  it("must be changed while the stored password is still the temporary one", () => {
    expect(mustChangePassword("h1", "h1")).toBe(true);
    expect(mustChangePassword("h2", "h1")).toBe(false);
    expect(mustChangePassword("h1", null)).toBe(false);
    expect(mustChangePassword(null, "h1")).toBe(false);
  });
});

describe("locked accounts", () => {
  it("are described as locked", () => {
    expect(lockedProblem({ lockedAt: new Date() })).toBe(LOCKED_MESSAGE);
    expect(lockedProblem({ lockedAt: null })).toBeNull();
    expect(lockedProblem(null)).toBeNull();
  });

  const user = { id: "u1", householdId: "h1", role: "parent", email: "mikkel@example.com" } as UserRow;
  const req = {
    cookies: { get: () => undefined },
    headers: new Headers({ "user-agent": "test", "x-forwarded-for": "1.2.3.4" }),
  } as unknown as Parameters<typeof completeSignIn>[0];

  it("can't sign in, by password or passkey: no session is made and the refusal is logged", async () => {
    isLocked.mockResolvedValue(true);
    createSession.mockReset();
    writeAudit.mockReset();
    for (const method of ["password", "passkey"] as const) {
      const err = await completeSignIn(req, user, method).catch((e) => e);
      expect(err).toBeInstanceOf(AuthError);
      expect((err as AuthError).status).toBe(403);
      expect((err as AuthError).message).toBe(LOCKED_MESSAGE);
    }
    expect(createSession).not.toHaveBeenCalled();
    expect(writeAudit).toHaveBeenCalledWith(user, "auth.login_refused", { type: "user", id: "u1" }, expect.objectContaining({ reason: "account_locked" }));
  });

  it("unlocked accounts sign in as before", async () => {
    isLocked.mockResolvedValue(false);
    createSession.mockResolvedValue({ token: "t".repeat(43), sessionId: "s1", approved: true });
    const res = await completeSignIn(req, user, "password");
    expect(res.status).toBe(200);
    expect(createSession).toHaveBeenCalledTimes(1);
  });
});
