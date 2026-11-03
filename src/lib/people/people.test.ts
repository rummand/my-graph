import { describe, expect, it } from "vitest";
import { BUILTIN_KINDS, BUILTIN_RELATIONS } from "@/lib/meta/builtins";
import { mergeMetaModel } from "@/lib/meta/model";
import { attentionItems, contactOverdue, nextBirthday, parseBirthday } from "./attention";
import { canSee } from "./access";
import { dotRadius, hasOverlap, layoutCircles, ringOf } from "./circles";
import { possessive, relationsToCenter, type PathEdge, type PathNode } from "./relpath";

const meta = mergeMetaModel("hh", {
  kinds: BUILTIN_KINDS.map((k, i) => ({ id: `k${i}`, householdId: null, nodeType: k.nodeType, key: k.key, label: k.label, pluralLabel: null, description: null, circle: k.circle ?? null, parentKey: null, icon: null, color: null, sortOrder: i, builtin: true })),
  relations: BUILTIN_RELATIONS.map((r, i) => ({ id: `r${i}`, householdId: null, key: r.key, label: r.label, inverseLabel: r.inverseLabel, category: r.category, fromTypes: r.fromTypes, toTypes: r.toTypes, symmetric: !!r.symmetric, builtin: true })),
  attributes: [],
});

describe("relation to you", () => {
  const nodes = new Map<string, PathNode>([
    ["me", { id: "me", label: "Anna", type: "person", kind: "parent" }],
    ["emma", { id: "emma", label: "Emma", type: "person", kind: "child" }],
    ["lars", { id: "lars", label: "Lars", type: "person", kind: "partner" }],
    ["mette", { id: "mette", label: "Mette", type: "person", kind: "teacher" }],
    ["ida", { id: "ida", label: "Ida", type: "person", kind: "childs_friend" }],
    ["idamum", { id: "idamum", label: "Sofie", type: "person", kind: "childs_friend_parent" }],
    ["gp", { id: "gp", label: "Dr. Holm", type: "person", kind: "doctor" }],
    ["bo", { id: "bo", label: "Bo", type: "person", kind: null }],
    ["jens", { id: "jens", label: "Jens", type: "person", kind: null }],
    ["doc", { id: "doc", label: "Letter", type: "document", kind: null }],
    ["old", { id: "old", label: "Old", type: "person", kind: null }],
  ]);
  const edges: PathEdge[] = [
    { id: "1", fromId: "me", toId: "emma", relation: "parent_of", status: "confirmed" },
    { id: "2", fromId: "lars", toId: "me", relation: "partner_of", status: "confirmed" },
    { id: "3", fromId: "mette", toId: "emma", relation: "teacher_of" },
    { id: "4", fromId: "ida", toId: "emma", relation: "friend_of" },
    { id: "5", fromId: "idamum", toId: "ida", relation: "parent_of" },
    { id: "6", fromId: "emma", toId: "gp", relation: "treated_by" },
    { id: "7", fromId: "me", toId: "bo", relation: "works_with" },
    { id: "8", fromId: "doc", toId: "jens", relation: "mentions" },
    { id: "9", fromId: "me", toId: "jens", relation: "mentions" },
    { id: "10", fromId: "me", toId: "old", relation: "knows", status: "rejected" },
  ];
  const fromMe = relationsToCenter(meta, "me", nodes, edges, { centerIsViewer: true });

  it("labels one-hop relations from your side", () => {
    expect(fromMe.get("emma")?.label).toBe("Your child");
    expect(fromMe.get("lars")?.label).toBe("Your partner");
    expect(fromMe.get("bo")?.label).toBe("Works with you");
  });
  it("labels two-hop relations through the middle person", () => {
    expect(fromMe.get("mette")).toMatchObject({ label: "Emma's teacher", hops: 2, via: { id: "emma" } });
    expect(fromMe.get("ida")?.label).toBe("Emma's friend");
    // treated_by isn't a noun: falls back to the person's kind
    expect(fromMe.get("gp")?.label).toBe("Emma's doctor");
  });
  it("stops at two hops, ignores non-person paths and rejected edges", () => {
    expect(fromMe.has("idamum")).toBe(false);
    expect(fromMe.has("jens")).toBe(false);
    expect(fromMe.has("old")).toBe(false);
  });
  it("re-centres on a child", () => {
    const fromEmma = relationsToCenter(meta, "emma", nodes, edges, { centerIsViewer: false });
    expect(fromEmma.get("mette")?.label).toBe("Emma's teacher");
    expect(fromEmma.get("me")?.label).toBe("Emma's parent");
    expect(fromEmma.get("idamum")?.label).toBe("Ida's parent");
  });
  it("forms possessives", () => {
    expect(possessive("Jens")).toBe("Jens'");
    expect(possessive("Emma")).toBe("Emma's");
  });
});

describe("birthdays", () => {
  it("parses full and year-less dates", () => {
    expect(parseBirthday("2017-11-05")).toEqual({ year: 2017, month: 11, day: 5 });
    expect(parseBirthday("--03-01")).toEqual({ year: null, month: 3, day: 1 });
    expect(parseBirthday("2017-02-30")).toBeNull();
    expect(parseBirthday(42)).toBeNull();
  });
  it("finds the next occurrence and age", () => {
    const today = new Date(2026, 10, 3); // 3 Nov 2026
    expect(nextBirthday("2017-11-05", today)).toMatchObject({ daysUntil: 2, turning: 9 });
    expect(nextBirthday("2017-11-03", today)).toMatchObject({ daysUntil: 0, turning: 9 });
    expect(nextBirthday("2017-11-02", today)?.date.getFullYear()).toBe(2027);
  });
  it("crosses the year end", () => {
    const nb = nextBirthday("1950-01-04", new Date(2026, 11, 28));
    expect(nb).toMatchObject({ daysUntil: 7, turning: 77 });
    expect(nb?.date.getFullYear()).toBe(2027);
  });
  it("celebrates 29 February on 28 February in common years", () => {
    const nb = nextBirthday("2016-02-29", new Date(2027, 0, 10));
    expect(nb?.date.getMonth()).toBe(1);
    expect(nb?.date.getDate()).toBe(28);
    expect(nextBirthday("2016-02-29", new Date(2028, 0, 10))?.date.getDate()).toBe(29);
  });
});

describe("attention rules", () => {
  const today = new Date(2026, 11, 26);
  const base = { createdAt: new Date(2025, 0, 1), kind: null as string | null };
  it("uses each circle's cadence", () => {
    expect(contactOverdue({ ...base, id: "a", label: "A", circle: "family", lastContactAt: new Date(2026, 11, 10) }, today)).toEqual({ daysSince: 16, cadenceDays: 14 });
    expect(contactOverdue({ ...base, id: "b", label: "B", circle: "family", lastContactAt: new Date(2026, 11, 13) }, today)).toBeNull();
    expect(contactOverdue({ ...base, id: "c", label: "C", circle: "close", lastContactAt: new Date(2026, 10, 20) }, today)?.daysSince).toBe(36);
    expect(contactOverdue({ ...base, id: "d", label: "D", circle: "social", lastContactAt: new Date(2026, 9, 1) }, today)).toBeNull();
    expect(contactOverdue({ ...base, id: "e", label: "E", circle: "work", lastContactAt: new Date(2020, 0, 1) }, today)).toBeNull();
  });
  it("skips people you live with and new people without contact yet", () => {
    expect(contactOverdue({ ...base, id: "f", label: "F", circle: "family", kind: "child", lastContactAt: null }, today)).toBeNull();
    expect(contactOverdue({ ...base, id: "g", label: "G", circle: "family", householdMember: true, lastContactAt: null }, today)).toBeNull();
    expect(contactOverdue({ ...base, id: "h", label: "H", circle: "family", createdAt: new Date(2026, 11, 20), lastContactAt: null }, today)).toBeNull();
    expect(contactOverdue({ ...base, id: "i", label: "I", circle: "family", lastContactAt: null }, today)).toEqual({ daysSince: null, cadenceDays: 14 });
  });
  it("lists low wellbeing, then birthdays across the year end, then overdue contact", () => {
    const items = attentionItems([
      { ...base, id: "a", label: "Aunt", circle: "family", lastContactAt: new Date(2026, 10, 1) },
      { ...base, id: "b", label: "Bedstefar", circle: "family", lastContactAt: new Date(2026, 11, 24), birthday: "1950-01-04" },
      { ...base, id: "c", label: "Cousin", circle: "family", lastContactAt: new Date(2026, 11, 24), birthday: "2001-01-15" },
      { ...base, id: "e", label: "Emma", circle: "family", kind: "child", lastContactAt: null, birthday: "2017-12-27", latestWellbeing: { score: 2, at: new Date(2026, 11, 25), note: "Tired" } },
    ], today);
    expect(items.map((i) => `${i.reason}:${i.personId}`)).toEqual(["wellbeing:e", "birthday:e", "birthday:b", "contact:a"]);
    const b = items.find((i) => i.personId === "b" && i.reason === "birthday");
    expect(b).toMatchObject({ date: "2027-01-04", daysUntil: 9, turning: 77 });
  });
});

describe("circle layout", () => {
  it("orders rings family → close → school/care → social → work → other", () => {
    expect(["family", "close", "school", "care", "social", "work", "other", "weird"].map(ringOf)).toEqual([0, 1, 2, 2, 3, 4, 5, 5]);
  });
  it("places many differently sized people without overlap", () => {
    const circles = ["family", "close", "school", "care", "social", "work", "other"];
    for (const count of [1, 2, 7, 40, 120]) {
      const items = Array.from({ length: count }, (_, i) => ({ id: `p${i}`, circle: circles[(i * 7 + (i % 3)) % circles.length], r: dotRadius((i * 13) % 11, 10) }));
      const layout = layoutCircles(items);
      expect(layout.placed).toHaveLength(count);
      expect(hasOverlap(layout.placed)).toBe(false);
      // nobody sits on the centre avatar
      for (const p of layout.placed) expect(Math.hypot(p.x, p.y)).toBeGreaterThanOrEqual(34 + p.r - 1e-6);
    }
  });
  it("keeps the top of each ring free for its label", () => {
    const items = Array.from({ length: 24 }, (_, i) => ({ id: `p${i}`, circle: ["family", "school", "social"][i % 3], r: 12 }));
    const l = layoutCircles(items);
    for (const p of l.placed) {
      const fromTop = Math.abs(Math.atan2(Math.sin(Math.atan2(p.y, p.x) + Math.PI / 2), Math.cos(Math.atan2(p.y, p.x) + Math.PI / 2)));
      const ring = l.rings.find((r) => r.index === p.ring)!;
      // the dot's edge stays clear of the label (≈ 6.4px per character)
      expect(fromTop * ring.radius - p.r).toBeGreaterThan((ring.label.length * 6.4) / 2 - 1);
    }
  });
  it("keeps inner circles inside outer ones", () => {
    const items = [...Array.from({ length: 30 }, (_, i) => ({ id: `s${i}`, circle: "social", r: 12 })), { id: "f", circle: "family", r: 18 }];
    const l = layoutCircles(items, { simulate: false });
    const fam = l.placed.find((p) => p.id === "f")!;
    const minSocial = Math.min(...l.placed.filter((p) => p.id !== "f").map((p) => Math.hypot(p.x, p.y)));
    expect(Math.hypot(fam.x, fam.y)).toBeLessThan(minSocial);
  });
});

describe("visibility", () => {
  const parent = { id: "p", householdId: "h", role: "parent" as const };
  const child = { id: "c", householdId: "h", role: "child" as const };
  const guest = { id: "g", householdId: "h", role: "guest" as const };
  it("follows owner / household / parents / private and the sensitive rule", () => {
    expect(canSee(child, { ownerId: "p", householdId: "h", visibility: "household" })).toBe(true);
    expect(canSee(child, { ownerId: "p", householdId: "h", visibility: "parents" })).toBe(false);
    expect(canSee(parent, { ownerId: "x", householdId: "h", visibility: "parents" })).toBe(true);
    expect(canSee(parent, { ownerId: "x", householdId: "h", visibility: "private" })).toBe(false);
    expect(canSee(child, { ownerId: "p", householdId: "h", visibility: "household", sensitive: true })).toBe(false);
    expect(canSee(child, { ownerId: "c", householdId: "h", visibility: "private", sensitive: true })).toBe(true);
    expect(canSee(guest, { ownerId: "p", householdId: "h", visibility: "household" })).toBe(false);
    expect(canSee(guest, { ownerId: "p", householdId: "h", visibility: "private" }, true)).toBe(true);
    expect(canSee(parent, { ownerId: "x", householdId: "other", visibility: "household" })).toBe(false);
  });
});
