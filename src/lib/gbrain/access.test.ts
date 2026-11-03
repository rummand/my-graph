import { describe, expect, it } from "vitest";
import { canEditItem, canReadEdgeItem, canReadItem, guestActive, nodeReadSql, shareActive, type AccessCtx, type AccessItem } from "./access";

const H = "h1", OTHER_H = "h2";
const now = new Date("2026-11-03T12:00:00Z");
const past = new Date("2026-11-01T00:00:00Z"), future = new Date("2026-12-01T00:00:00Z");
const ctx = (role: AccessCtx["role"], id: string = role, active = true): AccessCtx => ({ id, householdId: H, role, active });
const item = (p: Partial<AccessItem> = {}): AccessItem => ({ ownerId: "owner", householdId: H, visibility: "private", sensitive: false, ...p });

describe("canReadItem", () => {
  it("owner sees own private items", () => expect(canReadItem(ctx("owner"), item(), [], now)).toBe(true));
  it("private is owner only", () => {
    for (const r of ["parent", "child"] as const) expect(canReadItem(ctx(r), item(), [], now)).toBe(false);
  });
  it("parents visibility: owners and parents, not children", () => {
    const it_ = item({ visibility: "parents", ownerId: "someone" });
    expect(canReadItem(ctx("owner"), it_, [], now)).toBe(true);
    expect(canReadItem(ctx("parent"), it_, [], now)).toBe(true);
    expect(canReadItem(ctx("child"), it_, [], now)).toBe(false);
  });
  it("household visibility: everyone in the household, nobody outside", () => {
    const it_ = item({ visibility: "household" });
    expect(canReadItem(ctx("child"), it_, [], now)).toBe(true);
    expect(canReadItem({ ...ctx("parent"), householdId: OTHER_H }, it_, [], now)).toBe(false);
  });
  it("children never see sensitive items they don't own", () => {
    expect(canReadItem(ctx("child"), item({ visibility: "household", sensitive: true }), [], now)).toBe(false);
    expect(canReadItem(ctx("child"), item({ sensitive: true, ownerId: "child" }), [], now)).toBe(true);
    expect(canReadItem(ctx("child"), item({ sensitive: true }), [{ canEdit: true, expiresAt: null }], now)).toBe(false);
  });
  it("shares grant read until they expire", () => {
    expect(canReadItem(ctx("parent"), item(), [{ canEdit: false, expiresAt: future }], now)).toBe(true);
    expect(canReadItem(ctx("parent"), item(), [{ canEdit: false, expiresAt: past }], now)).toBe(false);
  });
  it("guests see only shared items, and only while active", () => {
    expect(canReadItem(ctx("guest"), item({ visibility: "household" }), [], now)).toBe(false);
    expect(canReadItem(ctx("guest"), item({ ownerId: "guest" }), [], now)).toBe(false);
    expect(canReadItem(ctx("guest"), item(), [{ canEdit: false, expiresAt: null }], now)).toBe(true);
    expect(canReadItem(ctx("guest", "guest", false), item(), [{ canEdit: false, expiresAt: null }], now)).toBe(false);
  });
});

describe("canEditItem", () => {
  it("owner edits own; household visibility does not grant edit", () => {
    expect(canEditItem(ctx("owner"), item(), [], now)).toBe(true);
    expect(canEditItem(ctx("parent"), item({ ownerId: "x" }), [], now)).toBe(false);
  });
  it("edit shares grant edit; read shares don't", () => {
    expect(canEditItem(ctx("parent"), item(), [{ canEdit: true, expiresAt: future }], now)).toBe(true);
    expect(canEditItem(ctx("parent"), item(), [{ canEdit: false, expiresAt: future }], now)).toBe(false);
    expect(canEditItem(ctx("parent"), item(), [{ canEdit: true, expiresAt: past }], now)).toBe(false);
  });
  it("guests edit only with an active edit share while active", () => {
    expect(canEditItem(ctx("guest"), item(), [{ canEdit: true, expiresAt: null }], now)).toBe(true);
    expect(canEditItem(ctx("guest", "guest", false), item(), [{ canEdit: true, expiresAt: null }], now)).toBe(false);
  });
});

describe("canReadEdgeItem", () => {
  const edge = { ownerId: "owner", householdId: H, visibility: "household" as const };
  it("needs both endpoints visible", () => {
    const hh = { item: item({ visibility: "household" }) };
    expect(canReadEdgeItem(ctx("child"), edge, hh, hh, now)).toBe(true);
    expect(canReadEdgeItem(ctx("child"), edge, hh, { item: item({ visibility: "parents" }) }, now)).toBe(false);
  });
  it("needs the edge itself visible", () => {
    const hh = { item: item({ visibility: "household" }) };
    expect(canReadEdgeItem(ctx("child"), { ...edge, visibility: "private" }, hh, hh, now)).toBe(false);
  });
  it("guests see facts between items shared with them", () => {
    const shared = { item: item(), shares: [{ canEdit: false, expiresAt: null }] };
    expect(canReadEdgeItem(ctx("guest"), { ...edge, visibility: "private" }, shared, shared, now)).toBe(true);
    expect(canReadEdgeItem(ctx("guest"), edge, shared, { item: item({ visibility: "household" }) }, now)).toBe(false);
  });
});

describe("helpers", () => {
  it("guest expiry must be in the future", () => {
    expect(guestActive(future, now)).toBe(true);
    expect(guestActive(past, now)).toBe(false);
    expect(guestActive(null, now)).toBe(false);
  });
  it("share without expiry never expires", () => expect(shareActive({ canEdit: false, expiresAt: null }, now)).toBe(true));
  it("SQL filter refuses bad aliases and short-circuits inactive viewers", () => {
    expect(() => nodeReadSql(ctx("owner"), 'n"; drop table x; --')).toThrow();
    expect(nodeReadSql(ctx("guest", "g", false), "n")).toBeTruthy();
  });
});
