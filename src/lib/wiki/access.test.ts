import { describe, expect, it } from "vitest";
import { canChangeVisibility, canDeletePage, canEditPage, canReadPage, type PageViewer, type Visibility } from "./access";

const H = "household-1";
const mom: PageViewer = { id: "mom", householdId: H, role: "owner" };
const dad: PageViewer = { id: "dad", householdId: H, role: "parent" };
const kid: PageViewer = { id: "kid", householdId: H, role: "child" };
const guest: PageViewer = { id: "guest", householdId: H, role: "guest" };
const stranger: PageViewer = { id: "x", householdId: "other", role: "owner" };

const page = (ownerId: string, visibility: Visibility) => ({ ownerId, householdId: H, visibility });

describe("canReadPage", () => {
  it("private: owner only", () => {
    const p = page("dad", "private");
    expect(canReadPage(dad, p)).toBe(true);
    expect(canReadPage(mom, p)).toBe(false);
    expect(canReadPage(kid, p)).toBe(false);
  });
  it("parents: owner and parents, never children", () => {
    const p = page("dad", "parents");
    expect(canReadPage(mom, p)).toBe(true);
    expect(canReadPage(kid, p)).toBe(false);
  });
  it("a child's own parents-only page is still theirs", () => {
    expect(canReadPage(kid, page("kid", "parents"))).toBe(true);
    expect(canReadPage(dad, page("kid", "parents"))).toBe(true);
  });
  it("household: everyone in the household, nobody outside it", () => {
    const p = page("mom", "household");
    expect(canReadPage(kid, p)).toBe(true);
    expect(canReadPage(dad, p)).toBe(true);
    expect(canReadPage(stranger, p)).toBe(false);
  });
  it("guests never see wiki pages", () => {
    expect(canReadPage(guest, page("mom", "household"))).toBe(false);
    expect(canReadPage(guest, page("guest", "private"))).toBe(false);
  });
});

describe("editing, deleting and visibility", () => {
  it("anyone who can read a shared page can edit it", () => {
    expect(canEditPage(kid, page("mom", "household"))).toBe(true);
    expect(canEditPage(dad, page("mom", "parents"))).toBe(true);
    expect(canEditPage(kid, page("mom", "parents"))).toBe(false);
  });
  it("only the owner, or a parent on a whole-family page, can delete", () => {
    expect(canDeletePage(mom, page("mom", "private"))).toBe(true);
    expect(canDeletePage(dad, page("kid", "household"))).toBe(true);
    expect(canDeletePage(dad, page("mom", "parents"))).toBe(false);
    expect(canDeletePage(kid, page("mom", "household"))).toBe(false);
  });
  it("only the owner changes who can see a page", () => {
    expect(canChangeVisibility(mom, page("mom", "household"))).toBe(true);
    expect(canChangeVisibility(dad, page("mom", "household"))).toBe(false);
  });
});
