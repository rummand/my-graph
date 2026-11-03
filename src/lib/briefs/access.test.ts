import { describe, expect, it } from "vitest";
import { canManageReminder, canSeeItem, visibleChildren } from "./access";
import { reminderCreateSchema, reminderPatchSchema, reminderQuerySchema } from "./schemas";
import { clearBriefCache, getCachedBrief, setCachedBrief } from "./cache";

const H = "h1";
const parent = { id: "p", householdId: H, role: "parent" as const };
const owner = { id: "o", householdId: H, role: "owner" as const };
const child = { id: "c", householdId: H, role: "child" as const };
const guest = { id: "g", householdId: H, role: "guest" as const };

describe("canSeeItem", () => {
  const item = (visibility: "private" | "parents" | "household", ownerId = "x", householdId = H) => ({ ownerId, householdId, visibility });
  it("lets owners see their own private items", () => expect(canSeeItem(child, item("private", "c"))).toBe(true));
  it("hides other people's private items, even from parents", () => expect(canSeeItem(parent, item("private"))).toBe(false));
  it("shows parents-only items to owners and parents, not children or guests", () => {
    expect(canSeeItem(owner, item("parents"))).toBe(true);
    expect(canSeeItem(parent, item("parents"))).toBe(true);
    expect(canSeeItem(child, item("parents"))).toBe(false);
    expect(canSeeItem(guest, item("parents"))).toBe(false);
  });
  it("shows household items to everyone but guests", () => {
    expect(canSeeItem(child, item("household"))).toBe(true);
    expect(canSeeItem(guest, item("household"))).toBe(false);
  });
  it("never crosses households", () => expect(canSeeItem(owner, item("household", "x", "other"))).toBe(false));
});

describe("canManageReminder", () => {
  it("allows the owner and household parents only", () => {
    expect(canManageReminder(child, { ownerId: "c", householdId: H })).toBe(true);
    expect(canManageReminder(parent, { ownerId: "c", householdId: H })).toBe(true);
    expect(canManageReminder(child, { ownerId: "p", householdId: H })).toBe(false);
    expect(canManageReminder(guest, { ownerId: "p", householdId: H })).toBe(false);
    expect(canManageReminder(parent, { ownerId: "c", householdId: "other" })).toBe(false);
  });
});

describe("visibleChildren", () => {
  const kids = [{ id: "c" }, { id: "c2" }];
  it("parents see all, a child sees themself, guests none", () => {
    expect(visibleChildren(parent, kids)).toHaveLength(2);
    expect(visibleChildren(child, kids)).toEqual([{ id: "c" }]);
    expect(visibleChildren(guest, kids)).toEqual([]);
  });
});

describe("reminder schemas", () => {
  it("accepts a manual reminder and normalises optional fields", () => {
    const r = reminderCreateSchema.parse({ title: "  Sign form ", dueAt: "2026-11-04T08:00:00+01:00", detail: "" });
    expect(r).toEqual({ title: "Sign form", dueAt: new Date("2026-11-04T07:00:00Z"), detail: null, aboutNodeId: null });
  });
  it("rejects bad input with readable messages", () => {
    expect(reminderCreateSchema.safeParse({ title: "", dueAt: "2026-11-04T08:00:00Z" }).success).toBe(false);
    expect(reminderCreateSchema.safeParse({ title: "x", dueAt: "tomorrow" }).success).toBe(false);
    expect(reminderCreateSchema.safeParse({ title: "x", dueAt: "2026-11-04T08:00:00Z", aboutNodeId: "nope" }).success).toBe(false);
    expect(reminderCreateSchema.safeParse({ title: "x", dueAt: "2026-11-04T08:00:00Z", ownerId: "evil" }).success).toBe(false);
  });
  it("requires at least one change in a patch", () => {
    expect(reminderPatchSchema.safeParse({}).success).toBe(false);
    expect(reminderPatchSchema.parse({ done: true })).toMatchObject({ done: true });
    expect(reminderPatchSchema.safeParse({ done: "yes" }).success).toBe(false);
  });
  it("reads query flags", () => {
    expect(reminderQuerySchema.parse({ upcoming: "" })).toMatchObject({ upcoming: true, days: 14, limit: 100 });
    expect(reminderQuerySchema.parse({ upcoming: "0" }).upcoming).toBe(false);
    expect(reminderQuerySchema.safeParse({ limit: "9999" }).success).toBe(false);
  });
});

describe("brief cache", () => {
  const brief = (day: string) => ({ text: "x", citations: [], generatedAt: "", day, model: null, local: true });
  it("keeps one day per user and forgets earlier days", () => {
    clearBriefCache();
    setCachedBrief("u1", brief("2026-11-03"));
    expect(getCachedBrief("u1", "2026-11-03")).not.toBeNull();
    setCachedBrief("u1", brief("2026-11-04"));
    expect(getCachedBrief("u1", "2026-11-03")).toBeNull();
    expect(getCachedBrief("u1", "2026-11-04")).not.toBeNull();
    expect(getCachedBrief("u2", "2026-11-04")).toBeNull();
  });
});
