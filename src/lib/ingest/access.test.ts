import { describe, expect, it } from "vitest";
import { canEditSourceRow, canReadSourceRow } from "./access";

const owner = { id: "u-owner", householdId: "h1", role: "parent" as const };
const parent = { id: "u-parent", householdId: "h1", role: "owner" as const };
const child = { id: "u-child", householdId: "h1", role: "child" as const };
const guest = { id: "u-guest", householdId: "h1", role: "guest" as const };
const stranger = { id: "u-x", householdId: "h2", role: "parent" as const };
const src = (visibility: "private" | "parents" | "household", sensitive = false) => ({ ownerId: owner.id, householdId: "h1", visibility, sensitive });

describe("canReadSourceRow", () => {
  it("private: only the owner (or an explicit share)", () => {
    expect(canReadSourceRow(owner, src("private"))).toBe(true);
    expect(canReadSourceRow(parent, src("private"))).toBe(false);
    expect(canReadSourceRow(guest, src("private"), true)).toBe(true);
  });
  it("parents: owner and parents, not children or guests", () => {
    expect(canReadSourceRow(parent, src("parents"))).toBe(true);
    expect(canReadSourceRow(child, src("parents"))).toBe(false);
    expect(canReadSourceRow(guest, src("parents"))).toBe(false);
  });
  it("household: everyone but guests and other households; sensitive stays with parents", () => {
    expect(canReadSourceRow(child, src("household"))).toBe(true);
    expect(canReadSourceRow(guest, src("household"))).toBe(false);
    expect(canReadSourceRow(stranger, src("household"))).toBe(false);
    expect(canReadSourceRow(child, src("household", true))).toBe(false);
    expect(canReadSourceRow(parent, src("household", true))).toBe(true);
  });
  it("only the owner edits", () => {
    expect(canEditSourceRow(owner, src("household"))).toBe(true);
    expect(canEditSourceRow(parent, src("household"))).toBe(false);
  });
});
