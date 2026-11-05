import { describe, expect, it, vi } from "vitest";

vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/lib/auth/members", () => ({ createAccount: vi.fn(), emailTaken: vi.fn() }));
vi.mock("@/lib/graphs", () => ({ createAccountWithOwnHousehold: vi.fn() }));

const { defaultHouseholdName, newAccountBody } = await import("./admin-create");

describe("new account from the admin console", () => {
  it("defaults to a Family graph and a password link", () => {
    const b = newAccountBody.parse({ name: " Ida ", email: " Ida@Example.COM " });
    expect(b).toMatchObject({ name: "Ida", email: "ida@example.com", firstGraph: "family", access: "link" });
  });

  it("needs a real email address (no usernames: they sign in with it)", () => {
    expect(newAccountBody.safeParse({ name: "Ida", email: "ida" }).success).toBe(false);
  });

  it("only offers Family or Personal as the first graph", () => {
    expect(newAccountBody.safeParse({ name: "Ida", email: "ida@example.com", firstGraph: "practice" }).success).toBe(false);
    expect(newAccountBody.parse({ name: "Ida", email: "ida@example.com", firstGraph: "personal", access: "temp" }).access).toBe("temp");
  });

  it("names the household after the person when left empty", () => {
    expect(defaultHouseholdName(" Ida ")).toBe("Ida's home");
  });
});
