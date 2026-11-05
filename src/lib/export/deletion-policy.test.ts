import { describe, expect, it } from "vitest";
import {
  FORMER_EMAIL_DOMAIN, GRACE_DAYS, confirmationMatches, deletionBlockers, deletionDueAt, formerMemberEmail, isFormerMember, keepsItem,
  planDeletion, signedInSince, type DeletionFacts,
} from "./deletion-policy";

const facts = (over: Partial<DeletionFacts> = {}): DeletionFacts => ({
  role: "parent", isPlatformAdmin: false, householdOthers: 3, sharedOwnedGraphs: [], ...over,
});

describe("who may delete their account", () => {
  it("a parent with nothing to hand over may", () => {
    expect(deletionBlockers(facts())).toEqual([]);
  });

  it("the platform admin may not", () => {
    expect(deletionBlockers(facts({ isPlatformAdmin: true })).map((b) => b.code)).toEqual(["platform_admin"]);
  });

  it("a child asks a parent", () => {
    expect(deletionBlockers(facts({ role: "child" })).map((b) => b.code)).toEqual(["child"]);
  });

  it("a household owner hands the household over first, unless they are its only member", () => {
    expect(deletionBlockers(facts({ role: "owner", householdOthers: 2 }))).toEqual([{ code: "household_owner", others: 2 }]);
    expect(deletionBlockers(facts({ role: "owner", householdOthers: 0 }))).toEqual([]);
  });

  it("a graph they own that others use is handed over first; one only they use is not a problem", () => {
    const b = deletionBlockers(facts({ sharedOwnedGraphs: [{ id: "g1", name: "Work", others: 2 }, { id: "g2", name: "Diary", others: 0 }] }));
    expect(b).toEqual([{ code: "shared_graph_owner", graphs: [{ id: "g1", name: "Work" }] }]);
  });
});

describe("confirmation and grace period", () => {
  it("needs their sign-in email, typed", () => {
    expect(confirmationMatches(" Anna@Example.com ", "anna@example.com")).toBe(true);
    expect(confirmationMatches("anna@example.co", "anna@example.com")).toBe(false);
    expect(confirmationMatches("", "")).toBe(false);
  });

  it("happens 7 days later, and signing in after asking cancels it", () => {
    const asked = new Date("2026-11-04T10:00:00Z");
    expect(GRACE_DAYS).toBe(7);
    expect(deletionDueAt(asked).toISOString()).toBe("2026-11-11T10:00:00.000Z");
    expect(signedInSince([{ createdAt: new Date("2026-11-01T10:00:00Z") }], asked)).toBe(false);
    expect(signedInSince([{ createdAt: new Date("2026-11-05T08:00:00Z") }], asked)).toBe(true);
    expect(signedInSince([], asked)).toBe(false);
  });
});

describe("what goes and what stays", () => {
  const U = "me";
  it("deletes graphs only they use; keeps shared ones (and someone else's family graph)", () => {
    const plan = planDeletion(U, "parent", "h1", 3, [
      { id: "family", ownerId: "mum", kind: "family", householdId: "h1", members: [U, "mum", "kid"] },
      { id: "diary", ownerId: U, kind: "personal", householdId: "h1", members: [U] },
      { id: "club", ownerId: "coach", kind: "shared", householdId: "h2", members: [U, "coach"] },
    ]);
    expect(plan).toEqual({ deleteHousehold: false, deleteGraphIds: ["diary"], keepGraphIds: ["family", "club"] });
  });

  it("an owner who is the household's only member takes the household and its family graph along", () => {
    const plan = planDeletion(U, "owner", "h1", 0, [
      { id: "family", ownerId: U, kind: "family", householdId: "h1", members: [U] },
      { id: "club", ownerId: "coach", kind: "shared", householdId: "h2", members: [U, "coach"] },
    ]);
    expect(plan).toEqual({ deleteHousehold: true, deleteGraphIds: ["family"], keepGraphIds: ["club"] });
  });

  it("private items always go; shared ones stay in kept graphs; other people's items are untouched", () => {
    const keep = new Set(["family"]);
    expect(keepsItem({ ownerId: U, graphId: "family", visibility: "private" }, U, keep)).toBe(false);
    expect(keepsItem({ ownerId: U, graphId: "family", visibility: "household" }, U, keep)).toBe(true);
    expect(keepsItem({ ownerId: U, graphId: "family", visibility: "parents" }, U, keep)).toBe(true);
    expect(keepsItem({ ownerId: U, graphId: "diary", visibility: "household" }, U, keep)).toBe(false);
    expect(keepsItem({ ownerId: "mum", graphId: "diary", visibility: "private" }, U, keep)).toBe(true);
  });

  it("stand-ins are recognisable and can't collide with real addresses", () => {
    const e = formerMemberEmail("123");
    expect(e).toBe(`former-123@${FORMER_EMAIL_DOMAIN}`);
    expect(isFormerMember(e)).toBe(true);
    expect(isFormerMember("anna@example.com")).toBe(false);
    expect(FORMER_EMAIL_DOMAIN.endsWith(".invalid")).toBe(true);
  });
});
